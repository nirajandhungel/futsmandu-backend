import { Injectable, Logger } from '@nestjs/common'
import * as crypto from 'crypto'
import { ENV } from '@futsmandu/utils'

const ESEWA_FUND_TRANSFER_URL = 'https://epay.esewa.com.np/api/epay/merchant-transaction/'
const GATEWAY_TIMEOUT_MS = 20_000

export interface EsewaTransferResult {
  success: boolean
  transferId?: string
  rawResponse: unknown
  failureReason?: string
}

export interface EsewaTransferRequest {
  payoutId: string
  ownerEsewaId: string
  amountNpr: number
  remarks: string
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

@Injectable()
export class EsewaPayoutService {
  private readonly logger = new Logger(EsewaPayoutService.name)

  async transferToOwner(req: EsewaTransferRequest): Promise<EsewaTransferResult> {
    const { payoutId, ownerEsewaId, amountNpr, remarks } = req

    if (!ownerEsewaId) {
      return {
        success: false,
        rawResponse: null,
        failureReason: 'Owner eSewa account is missing',
      }
    }
    if (!Number.isInteger(amountNpr) || amountNpr <= 0) {
      return {
        success: false,
        rawResponse: null,
        failureReason: `Invalid amount ${amountNpr}, must be integer NPR`,
      }
    }

    const merchantCode = ENV['ESEWA_MERCHANT_CODE']
    const secretKey = ENV['ESEWA_MERCHANT_SECRET']
    if (!merchantCode || !secretKey) {
      return {
        success: false,
        rawResponse: null,
        failureReason: 'eSewa payout environment keys are missing',
      }
    }

    const sigMessage = `${amountNpr},${merchantCode},${payoutId}`
    const signature = crypto.createHmac('sha256', secretKey).update(sigMessage).digest('base64')

    const payload = {
      amount: amountNpr,
      merchant_code: merchantCode,
      transaction_uuid: payoutId,
      receiver_id: ownerEsewaId,
      remarks,
      signature,
      signed_field_names: 'amount,merchant_code,transaction_uuid',
    }

    try {
      const res = await fetchWithTimeout(ESEWA_FUND_TRANSFER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'merchant-code': merchantCode,
        },
        body: JSON.stringify(payload),
      })

      const raw = (await res.json()) as Record<string, unknown>
      if (res.ok && raw['status'] === 'SUCCESS') {
        return {
          success: true,
          transferId: raw['transfer_id'] as string | undefined,
          rawResponse: raw,
        }
      }

      return {
        success: false,
        rawResponse: raw,
        failureReason: `eSewa responded with ${res.status}`,
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      this.logger.error(`eSewa transfer failed for payout ${payoutId}: ${reason}`)
      return {
        success: false,
        rawResponse: null,
        failureReason: reason,
      }
    }
  }
}

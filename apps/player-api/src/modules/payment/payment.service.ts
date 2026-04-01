// CHANGED: [C-1 parsePaisa integer arithmetic, C-3 null payment guard, SEC-4 base64/JSON try-catch]
// NEW ISSUES FOUND:
//   - esewaVerify decoded base64 without try-catch — JSON.parse threw unhandled exception (SEC-4)
//   - verifyEsewa decoded payload TWICE (once for bookingId, once inside esewaVerify) — redundant decode
//   - C-3: if payment record was null, code reached confirmPayment with no context

// apps/player-api/src/modules/payment/payment.service.ts
// Payment Service — Khalti + eSewa Strategy pattern.
// SECURITY: Always verify server-side. Never trust client-reported amounts.
// C-1: All money parsed with parsePaisa() — integer-only arithmetic, no parseFloat on currency.
// C-3: Null payment record throws NotFoundException immediately.
// SEC-4: Base64 decode + JSON.parse wrapped in try/catch; required fields validated.

import {
  Injectable, Logger, NotFoundException, ConflictException,
  BadRequestException,
} from '@nestjs/common'
import * as crypto from 'crypto'
import { PrismaService } from '@futsmandu/database'
import type { Prisma } from '@futsmandu/database'
import { BookingService } from '../booking/booking.service.js'
import type { GatewayVerification } from '@futsmandu/types'
import { ENV } from '@futsmandu/utils'

// ── C-1: Integer-only paisa parser ───────────────────────────────────────────
// Avoids floating-point multiplication: "1200.50" → 120050 (paisa)
// Never use parseFloat on currency strings.
function parsePaisa(amountStr: string): number {
  const [intPart = '0', decPart = '0'] = amountStr.split('.')
  const paisa = parseInt(intPart, 10) * 100
  const cents = parseInt(decPart.padEnd(2, '0').slice(0, 2), 10)
  return paisa + cents
}

// ── Gateway implementations ───────────────────────────────────────────────

async function khaltiInitiate(bookingId: string, amountPaisa: number) {
  const res = await fetch('https://a.khalti.com/api/v2/epayment/initiate/', {
    method: 'POST',
    headers: {
      Authorization: `Key ${ENV['KHALTI_SECRET_KEY']}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      return_url: `${ENV['APP_URL']}/payment/khalti-callback`,
      website_url: ENV['APP_URL'],
      amount: amountPaisa,
      purchase_order_id: bookingId,
      purchase_order_name: 'Futsmandu Slot Booking',
    }),
  })
  if (!res.ok) throw new Error(`Khalti initiation failed: ${await res.text()}`)
  const data = (await res.json()) as { payment_url: string; pidx: string }
  return { paymentUrl: data.payment_url, pidx: data.pidx }
}

async function khaltiVerify(pidx: string): Promise<GatewayVerification> {
  const res = await fetch(`https://a.khalti.com/api/v2/epayment/lookup/?pidx=${pidx}`, {
    headers: { Authorization: `Key ${ENV['KHALTI_SECRET_KEY']}` },
  })
  if (!res.ok) throw new Error(`Khalti lookup failed: ${res.status}`)
  const data = (await res.json()) as { status: string; total_amount: number; transaction_id: string }
  return {
    success: data.status === 'Completed',
    // Khalti returns amount already as integer paisa
    amount: data.total_amount,
    txId: data.transaction_id,
    raw: data as Record<string, unknown>,
  }
}

function esewaSign(message: string): string {
  return crypto.createHmac('sha256', ENV['ESEWA_SECRET_KEY']).update(message).digest('base64')
}

function esewaInitiate(bookingId: string, amountPaisa: number) {
  const amountNPR = amountPaisa / 100
  const productCode = ENV['ESEWA_PRODUCT_CODE']
  const signature = esewaSign(`${amountNPR},${bookingId},${productCode}`)
  return {
    signedPayload: {
      amount: amountNPR, tax_amount: 0, total_amount: amountNPR,
      transaction_uuid: bookingId, product_code: productCode,
      product_service_charge: 0, product_delivery_charge: 0,
      success_url: `${ENV['APP_URL']}/payment/esewa-callback`,
      failure_url: `${ENV['APP_URL']}/payment/esewa-failure`,
      signed_field_names: 'total_amount,transaction_uuid,product_code',
      signature,
    },
    esewaUrl: 'https://epay.esewa.com.np/api/epay/main/v2/form',
  }
}

// SEC-4: Wrapped in try/catch; required fields validated before use.
// C-1: Uses parsePaisa() instead of parseFloat * 100.
async function esewaVerify(encodedData: string): Promise<GatewayVerification> {
  let decoded: { total_amount: string; transaction_uuid: string; product_code: string; signature: string }

  try {
    decoded = JSON.parse(Buffer.from(encodedData, 'base64').toString('utf-8')) as typeof decoded
  } catch {
    throw new BadRequestException('Invalid eSewa response format — base64 decode or JSON parse failed')
  }

  // SEC-4: Validate required fields before accessing them
  if (!decoded.total_amount || !decoded.transaction_uuid || !decoded.signature || !decoded.product_code) {
    throw new BadRequestException('Incomplete eSewa response — missing required fields')
  }

  const expected = esewaSign(`${decoded.total_amount},${decoded.transaction_uuid},${decoded.product_code}`)
  if (expected !== decoded.signature) throw new ConflictException('eSewa HMAC mismatch — tampered payment')

  const statusRes = await fetch(
    `https://epay.esewa.com.np/api/epay/transaction/status/?product_code=${decoded.product_code}&total_amount=${decoded.total_amount}&transaction_uuid=${decoded.transaction_uuid}`,
  )
  const status = (await statusRes.json()) as { status: string }

  return {
    success: status.status === 'COMPLETE',
    // C-1: parsePaisa converts "1200.50" → 120050 using integer arithmetic
    amount: parsePaisa(decoded.total_amount),
    txId: decoded.transaction_uuid,
    raw: { ...decoded, statusApiResponse: status } as Record<string, unknown>,
  }
}

// ── PaymentService ─────────────────────────────────────────────────────────

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly bookingService: BookingService,
  ) { }

  async initiateKhalti(bookingId: string, playerId: string) {
    const payment = await this.bookingService.initiatePayment(bookingId, 'KHALTI', playerId)
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      select: { total_amount: true },
    })
    if (!booking) throw new NotFoundException('Booking not found')
    const result = await khaltiInitiate(bookingId, booking.total_amount)
    await this.prisma.payments.update({
      where: { id: payment.id },
      data: { gateway_tx_id: result.pidx },
    })
    return result
  }

  async verifyKhalti(pidx: string, bookingId: string) {
    const payment = await this.prisma.payments.findUnique({
      where: { booking_id: bookingId },
      select: { status: true },
    })
    if (!payment) throw new NotFoundException('Payment record not found')
    if (payment.status === 'SUCCESS') return this.prisma.bookings.findUnique({ where: { id: bookingId } })
    if (payment.status !== 'INITIATED') throw new ConflictException(`Payment is ${payment.status}`)

    const verified = await khaltiVerify(pidx)
    if (!verified.success) {
      await this.prisma.payments.update({
        where: { booking_id: bookingId },
        data: { status: 'FAILED', gateway_response: verified.raw as Prisma.InputJsonValue },
      })
      throw new ConflictException('Khalti payment was not completed')
    }
    return this.bookingService.confirmPayment(bookingId, verified, 'KHALTI')
  }

  async initiateEsewa(bookingId: string, playerId: string) {
    await this.bookingService.initiatePayment(bookingId, 'ESEWA', playerId)
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      select: { total_amount: true },
    })
    if (!booking) throw new NotFoundException('Booking not found')
    return esewaInitiate(bookingId, booking.total_amount)
  }

  async verifyEsewa(encodedData: string) {
    // SEC-4: decode once here with try/catch; extract bookingId safely
    let bookingId: string
    try {
      const raw = JSON.parse(Buffer.from(encodedData, 'base64').toString('utf-8')) as { transaction_uuid?: string }
      if (!raw.transaction_uuid) throw new Error('missing transaction_uuid')
      bookingId = raw.transaction_uuid
    } catch {
      throw new BadRequestException('Invalid eSewa response format')
    }

    // C-3: Throw immediately if no payment record exists — do not reach confirmPayment blind
    const payment = await this.prisma.payments.findUnique({
      where: { booking_id: bookingId },
      select: { status: true },
    })
    if (!payment) {
      throw new NotFoundException(`No payment record found for booking ${bookingId}`)
    }
    if (payment.status === 'SUCCESS') {
      return this.prisma.bookings.findUnique({ where: { id: bookingId } })
    }

    const verified = await esewaVerify(encodedData)
    if (!verified.success) {
      await this.prisma.payments.update({
        where: { booking_id: bookingId },
        data: { status: 'FAILED', gateway_response: verified.raw as Prisma.InputJsonValue },
      })
      throw new ConflictException('eSewa payment was not completed')
    }
    return this.bookingService.confirmPayment(bookingId, verified, 'ESEWA')
  }
}

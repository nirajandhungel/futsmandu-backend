import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { PrismaService } from '@futsmandu/database'
import type { Prisma } from '@futsmandu/database'
import { QUEUE_OWNER_PAYOUTS } from '@futsmandu/queues'
import { parsePlatformConfig } from '@futsmandu/utils'


export interface PayoutJobData {
  payoutId: string
}

@Injectable()
export class PayoutService {
  private readonly configCache = new Map<string, { value: any; expires: number }>()
  private readonly CACHE_TTL = 300_000 // 5 minutes

  private readonly logger = new Logger(PayoutService.name)

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_OWNER_PAYOUTS) private readonly payoutQueue: Queue<PayoutJobData>,
  ) {}

  async getConfig<T>(key: string, defaultValue: T): Promise<T> {
    const cached = this.configCache.get(key)
    if (cached && cached.expires > Date.now()) {
      return cached.value as T
    }

    const config = await this.prisma.platform_config.findUnique({
      where: { key },
    })

    if (!config) return defaultValue

    try {
      const parsed = parsePlatformConfig(config.value, config.type as 'number' | 'boolean' | 'string') as T
      this.configCache.set(key, { value: parsed, expires: Date.now() + this.CACHE_TTL })
      return parsed
    } catch (err) {

      this.logger.error(`Failed to parse config ${key}: ${String(err)}`)
      return defaultValue
    }
  }

  async getAdminFeePct(): Promise<number> {
    const pct = await this.getConfig('admin_fee_percent', 5)
    if (pct < 0 || pct > 100) return 5
    return pct
  }

  async isPayoutEnabled(): Promise<boolean> {
    return this.getConfig('payout_enabled', false)
  }

  clearCache(key?: string) {
    if (key) {
      this.configCache.delete(key)
    } else {
      this.configCache.clear()
    }
  }




  calculateSplit(totalAmount: number, adminFeePct: number): { adminFee: number; ownerAmount: number } {
    const adminFee = Math.floor((totalAmount * adminFeePct) / 100)
    return {
      adminFee,
      ownerAmount: totalAmount - adminFee,
    }
  }

  /**
   * Calculates the actual amount the platform owes the venue owner.
   * Payout = (Deposit collected by platform) - (Admin fee based on total booking price).
   * If negative, it means the owner owes the platform (rare if deposit covers fee).
   */
  calculatePlatformPayout(totalAmount: number, depositAmount: number, adminFeePct: number): { adminFee: number; ownerPayout: number } {
    const adminFee = Math.floor((totalAmount * adminFeePct) / 100)
    return {
      adminFee,
      ownerPayout: depositAmount - adminFee,
    }
  }

  buildPayoutCreateOp(params: {
    paymentId: string
    bookingId: string
    ownerId: string
    venueId: string
    ownerEsewaId: string
    totalAmount: number
    adminFee: number
    ownerAmount: number
    adminFeePct: number
  }): Prisma.owner_payoutsCreateArgs {
    return {
      data: {
        payment_id: params.paymentId,
        booking_id: params.bookingId,
        owner_id: params.ownerId,
        venue_id: params.venueId,
        owner_esewa_id: params.ownerEsewaId,
        total_collected: params.totalAmount,
        admin_fee: params.adminFee,
        owner_amount: params.ownerAmount,
        admin_fee_pct: params.adminFeePct,
        status: 'PENDING',
        // Manual admin-triggered payout (we reuse existing enum value to avoid enum drift
        // when Prisma client isn't regenerated in CI/build).
        trigger: 'MANUAL_RETRY',
      },
    }
  }

  async enqueuePayoutJob(payoutId: string): Promise<void> {
    const enabled = await this.isPayoutEnabled()
    if (!enabled) {
      this.logger.warn(`Skipping payout ${payoutId}: payouts are globally disabled`)
      return
    }

    try {
      await this.payoutQueue.add(
        'process-payout',
        { payoutId },
        {
          jobId: `payout:${payoutId}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: { count: 500 },
          removeOnFail: false,
        },
      )
    } catch (err) {
      this.logger.error(`Failed to enqueue payout ${payoutId}: ${String(err)}`)
    }
  }

  async adminRetryPayout(payoutId: string, _adminId: string): Promise<void> {
    const enabled = await this.isPayoutEnabled()
    if (!enabled) {
      throw new BadRequestException('Payouts are currently disabled globally')
    }

    const payout = await this.prisma.owner_payouts.findUnique({ where: { id: payoutId } })

    if (!payout) throw new NotFoundException('Payout not found')
    if (payout.status === 'SUCCESS') throw new BadRequestException('Payout is already successful')

    await this.prisma.owner_payouts.update({
      where: { id: payoutId },
      data: {
        status: 'PENDING',
        trigger: 'MANUAL_RETRY',
        last_failure_reason: null,
      },
    })

    await this.enqueuePayoutJob(payoutId)
  }
}

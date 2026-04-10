import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { PrismaService } from '@futsmandu/database'
import type { Prisma } from '@futsmandu/database'
import { QUEUE_OWNER_PAYOUTS } from '@futsmandu/queues'

export interface PayoutJobData {
  payoutId: string
}

@Injectable()
export class PayoutService {
  private readonly logger = new Logger(PayoutService.name)

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_OWNER_PAYOUTS) private readonly payoutQueue: Queue<PayoutJobData>,
  ) {}

  async getAdminFeePct(): Promise<number> {
    const config = await this.prisma.platform_config.findUnique({
      where: { key: 'admin_fee_percent' },
    })
    if (!config) return 5
    const pct = Number.parseInt(config.value, 10)
    if (Number.isNaN(pct) || pct < 0 || pct > 100) return 5
    return pct
  }

  calculateSplit(totalPaisa: number, adminFeePct: number): { adminFee: number; ownerAmount: number } {
    const adminFee = Math.floor((totalPaisa * adminFeePct) / 100)
    return {
      adminFee,
      ownerAmount: totalPaisa - adminFee,
    }
  }

  buildPayoutCreateOp(params: {
    paymentId: string
    bookingId: string
    ownerId: string
    venueId: string
    ownerEsewaId: string
    totalPaisa: number
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
        total_collected: params.totalPaisa,
        admin_fee: params.adminFee,
        owner_amount: params.ownerAmount,
        admin_fee_pct: params.adminFeePct,
        status: 'PENDING',
        trigger: 'AUTO_SPLIT',
      },
    }
  }

  async enqueuePayoutJob(payoutId: string): Promise<void> {
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

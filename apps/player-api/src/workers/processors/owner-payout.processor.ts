import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq'
import { Logger, Inject, OnModuleInit } from '@nestjs/common'
import { Job } from 'bullmq'
import { PrismaService } from '@futsmandu/database'
import { RedisService } from '@futsmandu/redis'
import { QUEUE_OWNER_PAYOUTS } from '@futsmandu/queues'
import { EsewaPayoutService, type PayoutJobData } from '@futsmandu/esewa-payout'

@Processor(QUEUE_OWNER_PAYOUTS, { concurrency: 3 })
export class OwnerPayoutProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(OwnerPayoutProcessor.name)

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(EsewaPayoutService) private readonly esewaPayouts: EsewaPayoutService,
  ) {
    super()
  }

  async onModuleInit(): Promise<void> {
    await this.redis.waitForReady()
  }

  async process(job: Job<PayoutJobData>): Promise<void> {
    const payout = await this.prisma.owner_payouts.findUnique({ where: { id: job.data.payoutId } })
    if (!payout) return
    if (payout.status === 'SUCCESS' || payout.status === 'MANUALLY_RESOLVED') return

    await this.prisma.owner_payouts.update({
      where: { id: payout.id },
      data: {
        status: 'PROCESSING',
        last_attempted_at: new Date(),
        attempt_count: { increment: 1 },
      },
    })

    const result = await this.esewaPayouts.transferToOwner({
      payoutId: payout.id,
      ownerEsewaId: payout.owner_esewa_id,
      amountNpr: Math.floor(payout.owner_amount / 100),
      remarks: `Futsmandu payout ${payout.booking_id.slice(0, 8)}`,
    })

    if (!result.success) {
      await this.prisma.owner_payouts.update({
        where: { id: payout.id },
        data: {
          status: 'PENDING',
          esewa_response: result.rawResponse as any,
          last_failure_reason: result.failureReason ?? 'Unknown payout failure',
        },
      })
      throw new Error(result.failureReason ?? 'Payout transfer failed')
    }

    await this.prisma.owner_payouts.update({
      where: { id: payout.id },
      data: {
        status: 'SUCCESS',
        completed_at: new Date(),
        esewa_transfer_id: result.transferId,
        esewa_response: result.rawResponse as any,
        last_failure_reason: null,
      },
    })
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<PayoutJobData>, err: Error): Promise<void> {
    await this.prisma.owner_payouts.update({
      where: { id: job.data.payoutId },
      data: {
        status: 'FAILED',
        last_failure_reason: err.message,
      },
    }).catch(() => undefined)
    this.logger.error(`Payout failed ${job.data.payoutId}: ${err.message}`)
  }
}

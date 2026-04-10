import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq'
import { Logger, Inject, OnModuleInit } from '@nestjs/common'
import { Job, Queue } from 'bullmq'
import { PrismaService } from '@futsmandu/database'
import { RedisService } from '@futsmandu/redis'
import { PayoutService } from '@futsmandu/esewa-payout'
import { QUEUE_PAYOUT_RETRY, QUEUE_OWNER_PAYOUTS } from '@futsmandu/queues'

@Processor(QUEUE_PAYOUT_RETRY)
export class PayoutReconcilerProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(PayoutReconcilerProcessor.name)

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(PayoutService) private readonly payoutService: PayoutService,
    @InjectQueue(QUEUE_PAYOUT_RETRY) private readonly reconQueue: Queue,
    @InjectQueue(QUEUE_OWNER_PAYOUTS) private readonly payoutQueue: Queue,
  ) {
    super()
  }

  async onModuleInit(): Promise<void> {
    await this.redis.waitForReady()
    await this.reconQueue.add('reconcile', {}, {
      repeat: { every: 10 * 60 * 1000 },
      jobId: 'payout-reconciler-tick',
    })
  }

  async process(_job: Job): Promise<void> {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000)
    const pending = await this.prisma.owner_payouts.findMany({
      where: {
        status: 'PENDING',
        created_at: { lte: cutoff },
        OR: [{ last_attempted_at: null }, { last_attempted_at: { lte: cutoff } }],
      },
      select: { id: true },
      take: 50,
    })

    for (const payout of pending) {
      const existingJob = await this.payoutQueue.getJob(`payout:${payout.id}`)
      if (existingJob) {
        const state = await existingJob.getState()
        if (state === 'waiting' || state === 'active' || state === 'delayed') continue
      }
      await this.payoutService.enqueuePayoutJob(payout.id)
    }

    this.logger.log(`Payout reconciler checked ${pending.length} pending payouts`)
  }
}

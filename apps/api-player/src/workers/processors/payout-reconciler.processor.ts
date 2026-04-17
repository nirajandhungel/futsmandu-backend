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
    // Payouts are admin-triggered only (no automatic retries/scheduling).
  }

  async process(_job: Job): Promise<void> {
    this.logger.debug('Payout reconciler disabled (admin-triggered payouts)')
  }
}

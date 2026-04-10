import { Module } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'
import { QUEUE_OWNER_PAYOUTS } from '@futsmandu/queues'
import { EsewaPayoutService } from './esewa-payout.service.js'
import { PayoutService } from './payout.service.js'

@Module({
  imports: [BullModule.registerQueue({ name: QUEUE_OWNER_PAYOUTS })],
  providers: [EsewaPayoutService, PayoutService],
  exports: [EsewaPayoutService, PayoutService],
})
export class EsewaPayoutModule {}

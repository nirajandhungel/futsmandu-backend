// apps/player-api/src/workers/worker.module.ts
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { PrismaModule } from '@futsmandu/database'
import { NotificationProcessor } from './processors/notification.processor.js'
import { SlotExpiryProcessor } from './processors/slot-expiry.processor.js'
import { PaymentReconProcessor } from './processors/payment-recon.processor.js'
import {
  RefundProcessor,
  StatsProcessor,
  EmailProcessor,
  SmsProcessor,
} from './processors/refund.processor.js'
import { BookingModule } from '../modules/booking/booking.module.js'
import { PaymentModule } from '../modules/payment/payment.module.js'
import { QueuesModule } from '../queues.module.js'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env', '.env'], cache: true }),
    PrismaModule,
    // Centralized queue registration (prevents duplicate queue/worker instances)
    QueuesModule,
    BookingModule,
    PaymentModule,
  ],
  providers: [
    NotificationProcessor,
    SlotExpiryProcessor,
    PaymentReconProcessor,
    RefundProcessor,
    StatsProcessor,
    EmailProcessor,
    SmsProcessor,
  ],
})
export class WorkerModule { }

// apps/player-api/src/workers/worker.module.ts
// FIX: Updated imports — StatsProcessor, EmailProcessor, SmsProcessor now come from
// their own dedicated files instead of the multi-class refund.processor.ts.
// Multi-class processor files with aliased NestJS decorator imports caused fragile
// processor registration. One file per processor is the correct NestJS pattern.

import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { PrismaModule } from '@futsmandu/database'
import { NotificationProcessor } from './processors/notification.processor.js'
import { SlotExpiryProcessor } from './processors/slot-expiry.processor.js'
import { PaymentReconProcessor } from './processors/payment-recon.processor.js'
import { RefundProcessor } from './processors/refund.processor.js'
import { StatsProcessor } from './processors/stats.processor.js'
import { EmailProcessor } from './processors/email.processor.js'
import { SmsProcessor } from './processors/sms.processor.js'
import { SchedulerService } from './scheduler.service.js'
import { BookingModule } from '../modules/booking/booking.module.js'
import { PaymentModule } from '../modules/payment/payment.module.js'
import { QueuesModule } from '@futsmandu/queues'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env', '.env'], cache: true }),
    PrismaModule,
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
    // Registers slot-expiry (2 min) and payment-recon (15 min) repeatable jobs on startup.
    SchedulerService,
  ],
})
export class WorkerModule {}

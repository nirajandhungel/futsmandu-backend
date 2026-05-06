// apps/player-api/src/workers/worker.module.ts
// FIX: Updated imports — StatsProcessor, EmailProcessor, SmsProcessor now come from
// their own dedicated files instead of the multi-class refund.processor.ts.
// Multi-class processor files with aliased NestJS decorator imports caused fragile
// processor registration. One file per processor is the correct NestJS pattern.

import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { PrismaModule } from '@futsmandu/database'
import { SentryModule } from '@sentry/nestjs/setup'
import { NotificationProcessor } from './processors/notification.processor.js'
import { SlotExpiryProcessor } from './processors/slot-expiry.processor.js'
import { PaymentReconProcessor } from './processors/payment-recon.processor.js'
import { RefundProcessor } from './processors/refund.processor.js'
import { StatsProcessor } from './processors/stats.processor.js'
import { EmailProcessor } from './processors/email.processor.js'
import { SmsProcessor } from './processors/sms.processor.js'
import { MediaOrphanCleanupProcessor } from './processors/media-orphan-cleanup.processor.js'
import { AuditLogProcessor } from './processors/audit-log.processor.js'
import { SecurityIncidentProcessor } from './processors/security-incident.processor.js'
import { SchedulerService } from './scheduler.service.js'
import { BookingModule } from '../modules/booking/booking.module.js'
import { PaymentModule } from '../modules/payment/payment.module.js'
import { QueuesModule } from '@futsmandu/queues'
import { EsewaPayoutModule } from '@futsmandu/esewa-payout'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env', '.env'], cache: true }),
    SentryModule.forRoot(),
    PrismaModule,
    QueuesModule,
    EsewaPayoutModule,
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
    MediaOrphanCleanupProcessor,
    AuditLogProcessor,
    SecurityIncidentProcessor,
    SchedulerService,
  ],
})
export class WorkerModule {}

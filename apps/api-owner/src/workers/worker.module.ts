// apps/owner-api/src/workers/worker.module.ts
// CHANGED: Removed local ImageProcessingProcessor import.
// Now uses MediaModule.forWorker() which registers the shared processor.
//
// DELETE: apps/owner-api/src/workers/processors/image-processing.processor.ts

import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { BullModule } from '@nestjs/bullmq'
import { MediaModule } from '@futsmandu/media'
import { QueuesModule } from '@futsmandu/queues'
import { DatabaseModule } from '@futsmandu/database'
import { SentryModule } from '@sentry/nestjs/setup'
import { OwnerEmailProcessor }        from './processors/email.processor.js'
import { OwnerNotificationProcessor } from './processors/notification.processor.js'
import { OwnerSmsProcessor }          from './processors/sms.processor.js'
// ✂️  REMOVED: import { ImageProcessingProcessor } from './processors/image-processing.processor.js'
//              → this now lives in @futsmandu/media and is registered by MediaModule.forWorker()

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env', '.env'], cache: true }),
    SentryModule.forRoot(),
    DatabaseModule,
    QueuesModule,
    MediaModule.forWorker(),   // ← registers shared ImageProcessingProcessor
  ],
  providers: [
    OwnerEmailProcessor,
    OwnerNotificationProcessor,
    OwnerSmsProcessor,
    // ✂️  REMOVED: ImageProcessingProcessor
  ],
})
export class OwnerWorkerModule {}
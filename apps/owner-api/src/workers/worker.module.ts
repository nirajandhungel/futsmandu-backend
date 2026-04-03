// apps/owner-api/src/workers/worker.module.ts
// Owner-specific BullMQ workers — notification, email, SMS, image-processing.
// Completely independent from player-api workers.
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { PrismaModule } from '@futsmandu/database'
import { OwnerNotificationProcessor } from './processors/notification.processor.js'
import { OwnerEmailProcessor }        from './processors/email.processor.js'
import { OwnerSmsProcessor }          from './processors/sms.processor.js'
import { ImageProcessingProcessor }   from './processors/image-processing.processor.js'
import { QueuesModule } from '@futsmandu/queues'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.owner', '../../.env', '.env'], cache: true }),
    PrismaModule,
    // Centralized queue registration (prevents duplicate queue/worker instances)
    QueuesModule,
  ],
  providers: [
    OwnerNotificationProcessor,
    OwnerEmailProcessor,
    OwnerSmsProcessor,
    ImageProcessingProcessor,
  ],
})
export class OwnerWorkerModule {}

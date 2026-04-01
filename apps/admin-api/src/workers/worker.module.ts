// apps/admin-api/src/workers/worker.module.ts
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { PrismaModule } from '@futsmandu/database'
import { AdminEmailProcessor } from './processors/email.processor.js'
import { QueuesModule } from '../queues.module.js'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.admin', '../../.env', '.env'], cache: true }),
    PrismaModule,
    // Centralized queue registration (prevents duplicate queue/worker instances)
    QueuesModule,
  ],
  providers: [AdminEmailProcessor],
})
export class AdminWorkerModule {}

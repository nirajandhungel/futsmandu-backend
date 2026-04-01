// apps/player-api/src/modules/health/health.module.ts
import { Module } from '@nestjs/common'
import { HealthController } from './health.controller.js'
import { QueuesModule } from '../../queues.module.js'

@Module({
  imports: [QueuesModule],
  controllers: [HealthController],
})
export class HealthModule {}

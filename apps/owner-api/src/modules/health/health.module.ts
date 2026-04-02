// apps/owner-api/src/modules/health/health.module.ts
// FIX: Added PrismaModule + RedisModule imports so PrismaService and RedisService
// can be injected into HealthController. Previously the controller had no dependencies
// so no imports were needed; the new health check requires both.
// Note: PrismaModule and RedisModule are @Global(), so they are technically available
// without explicit import — but explicit imports are required for NestJS DI to resolve
// them correctly when the module is bootstrapped in isolation (e.g. tests).

import { Module } from '@nestjs/common'
import { PrismaModule } from '@futsmandu/database'
import { RedisModule } from '@futsmandu/redis'
import { HealthController } from './health.controller.js'

@Module({
  imports: [PrismaModule, RedisModule],
  controllers: [HealthController],
})
export class HealthModule {}

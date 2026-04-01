// apps/owner-api/src/modules/health/health.module.ts
import { Module } from '@nestjs/common'
import { HealthController } from './health.controller.js'

@Module({ controllers: [HealthController] })
export class HealthModule {}

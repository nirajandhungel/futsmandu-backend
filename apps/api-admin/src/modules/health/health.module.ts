// apps/admin-api/src/modules/health/health.module.ts
import { Module } from '@nestjs/common'
import { AdminHealthController } from './health.controller.js'

@Module({ controllers: [AdminHealthController] })
export class AdminHealthModule {}

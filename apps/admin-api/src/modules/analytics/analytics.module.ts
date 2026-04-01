// apps/admin-api/src/modules/analytics/analytics.module.ts
import { Module } from '@nestjs/common'
import { AdminAnalyticsController } from './analytics.controller.js'
import { AnalyticsService } from './analytics.service.js'

@Module({
  controllers: [AdminAnalyticsController],
  providers: [AnalyticsService],
})
export class AdminAnalyticsModule {}

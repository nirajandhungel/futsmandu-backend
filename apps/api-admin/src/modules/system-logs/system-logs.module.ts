import { Module } from '@nestjs/common';
import { AdminSystemLogsController } from './system-logs.controller.js';
import { AdminAnalyticsModule } from '../analytics/analytics.module.js';

@Module({
  imports: [AdminAnalyticsModule],
  controllers: [AdminSystemLogsController],
})
export class AdminSystemLogsModule {}

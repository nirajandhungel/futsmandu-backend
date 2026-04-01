import { Module } from '@nestjs/common'
import { AnalyticsController } from './analytics.controller.js'
import { AnalyticsService } from './analytics.service.js'
import { OwnerAuthModule } from '../owner-auth/owner-auth.module.js'
import { RolesGuard } from '../../common/guards/roles.guard.js'

@Module({
  imports: [OwnerAuthModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, RolesGuard],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}

// apps/admin-api/src/modules/analytics/analytics.controller.ts
// Platform-wide analytics for admin dashboard — not owner-scoped.
import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { AnalyticsService } from './analytics.service.js'
import { AdminJwtGuard } from '../../common/guards/jwt.guard.js'

@ApiTags('Admin Analytics')
@ApiBearerAuth('Admin-JWT')
@UseGuards(AdminJwtGuard)
@Controller('analytics')
export class AdminAnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('platform')
  @ApiOperation({ summary: 'Platform-wide KPIs — total bookings, revenue, users' })
  platformSummary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.getPlatformSummary({ from, to })
  }

  @Get('venues/summary')
  @ApiOperation({ summary: 'Per-venue revenue summary across all venues' })
  venueSummary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.getVenueSummary({ from, to })
  }

  @Get('revenue')
  @ApiOperation({ summary: 'Revenue grouped by day/week/month across all venues' })
  revenue(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('groupBy') groupBy: 'day' | 'week' | 'month' = 'day',
  ) {
    return this.analytics.getRevenue({ from, to, groupBy })
  }

  @Get('no-show-rate')
  @ApiOperation({ summary: 'No-show rate across all venues' })
  noShowRate(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.getNoShowRate({ from, to })
  }

  @Get('user-growth')
  @ApiOperation({ summary: 'Player + owner registration growth' })
  userGrowth(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.getUserGrowth({ from, to })
  }

  @Get('audit-logs')
  @ApiOperation({ summary: 'System-wide admin action logs' })
  auditLogs(@Query('limit') limit?: number, @Query('cursor') cursor?: string) {
    return this.analytics.getAuditLogs({ limit: limit ? +limit : undefined, cursor })
  }
}


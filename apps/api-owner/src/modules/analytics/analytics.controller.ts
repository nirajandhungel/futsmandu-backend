import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { IsOptional, IsDateString, IsIn } from 'class-validator'
import { ApiPropertyOptional } from '@nestjs/swagger'
import { AnalyticsService } from './analytics.service.js'
import { OwnerJwtGuard } from '../../common/guards/owner-jwt.guard.js'
import { RolesGuard } from '../../common/guards/roles.guard.js'
import { CurrentOwner } from '../../common/decorators/current-owner.decorator.js'
import type { AuthOwner } from '../../common/guards/owner-jwt.guard.js'

class AnalyticsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string
  @ApiPropertyOptional() @IsOptional() courtId?: string
}

class RevenueQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string
  @ApiPropertyOptional() @IsOptional() courtId?: string
  @ApiPropertyOptional({ enum: ['day', 'week', 'month'] })
  @IsOptional() @IsIn(['day', 'week', 'month']) groupBy?: 'day' | 'week' | 'month'
}

@ApiTags('Analytics')
@ApiBearerAuth('Owner-JWT')
@UseGuards(OwnerJwtGuard, RolesGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Revenue + booking counts' })
  summary(@CurrentOwner() owner: AuthOwner, @Query() query: AnalyticsQueryDto) {
    return this.analytics.getSummary(owner.id, query)
  }

  @Get('heatmap')
  @ApiOperation({ summary: 'Occupancy by hour/day of week' })
  heatmap(@CurrentOwner() owner: AuthOwner, @Query() query: AnalyticsQueryDto) {
    return this.analytics.getHeatmap(owner.id, query)
  }

  @Get('revenue')
  @ApiOperation({ summary: 'Revenue grouped by day/week/month' })
  revenue(@CurrentOwner() owner: AuthOwner, @Query() query: RevenueQueryDto) {
    return this.analytics.getRevenue(owner.id, query)
  }

  @Get('no-show-rate')
  @ApiOperation({ summary: 'No-show % by court' })
  noShowRate(@CurrentOwner() owner: AuthOwner, @Query() query: AnalyticsQueryDto) {
    return this.analytics.getNoShowRate(owner.id, query)
  }
}

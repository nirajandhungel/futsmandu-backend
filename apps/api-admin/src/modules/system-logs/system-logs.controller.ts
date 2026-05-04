import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { AdminJwtGuard } from '../../common/guards/jwt.guard.js';
import { RolesGuard, Roles } from '../../common/guards/roles.guard.js';

@ApiTags('Admin — System Logs')
@ApiBearerAuth('Admin-JWT')
@UseGuards(AdminJwtGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('logs')
export class AdminSystemLogsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  @ApiOperation({ summary: 'List system audit logs' })
  async list(@Query('page') page?: number, @Query('limit') limit?: number) {
    const limitNum = limit ? +limit : 20;
    const items = await this.analytics.getAuditLogs({ limit: limitNum });
    
    return {
      items,
      page: page ? +page : 1,
      totalPages: 1, // Placeholder for real pagination
      totalItems: items.length,
    };
  }
}

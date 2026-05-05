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
  async list(
    @Query('page') page?: number, 
    @Query('limit') limit?: number,
    @Query('actor_type') actorType?: string
  ) {
    const pageNum = page ? +page : 1;
    const limitNum = limit ? +limit : 20;
    const skip = (pageNum - 1) * limitNum;

    const { items, total } = await this.analytics.getAuditLogs({ 
      limit: limitNum, 
      skip,
      actor_type: actorType && actorType !== 'all' ? actorType.toUpperCase() : undefined 
    });
    
    return {
      items,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
      totalItems: total,
    };
  }
}

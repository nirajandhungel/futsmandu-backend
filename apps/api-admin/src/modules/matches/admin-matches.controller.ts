import { Controller, Get, Query, Param, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AdminMatchesService } from './admin-matches.service.js';
import { AdminJwtGuard } from '../../common/guards/jwt.guard.js';
import { RolesGuard, Roles } from '../../common/guards/roles.guard.js';
import { ListMatchesQueryDto } from './dto/match.dto.js';

@ApiTags('Admin — Matches')
@ApiBearerAuth('Admin-JWT')
@UseGuards(AdminJwtGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('matches')
export class AdminMatchesController {
  constructor(private readonly matchesService: AdminMatchesService) {}

  @Get()
  @ApiOperation({ summary: 'List all matches for moderation' })
  list(@Query() query: ListMatchesQueryDto) {
    return this.matchesService.listMatches(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get match detail with members and teams' })
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.matchesService.getMatchDetail(id);
  }
}

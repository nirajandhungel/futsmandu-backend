import {
  Controller, Get, Put, Param, Query, Body, UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { IsString, IsNotEmpty, IsIn, IsOptional } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { AdminPenaltiesService } from './penalties.service.js'
import { AdminJwtGuard } from '../../common/guards/jwt.guard.js'
import { RolesGuard, Roles } from '../../common/guards/roles.guard.js'
import { CurrentAdmin } from '../../common/decorators/user.decorator.js'
import type { AuthAdmin } from '../../common/guards/jwt.guard.js'

class OverridePenaltyDto {
  @ApiProperty() @IsString() @IsNotEmpty() adminNote!: string
}

class ResolveDisputeDto {
  @ApiProperty({ enum: ['resolved_noshow', 'resolved_cleared'] })
  @IsIn(['resolved_noshow', 'resolved_cleared'])
  resolution!: 'resolved_noshow' | 'resolved_cleared'
}

@ApiTags('Admin — Penalties')
@ApiBearerAuth('Admin-JWT')
@UseGuards(AdminJwtGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller()
export class AdminPenaltiesController {
  constructor(private readonly penalties: AdminPenaltiesService) {}

  @Get('penalties')
  @ApiOperation({ summary: 'List active/expired penalties' })
  list(
    @Query('status') status?: 'active' | 'expired' | 'all',
    @Query('page') page?: number,
  ) {
    return this.penalties.listPenalties(status ?? 'active', page)
  }

  @Put('penalties/:id/override')
  @ApiOperation({ summary: 'Override ban — logs admin note' })
  override(
    @CurrentAdmin() admin: AuthAdmin,
    @Param('id') penaltyId: string,
    @Body() dto: OverridePenaltyDto,
  ) {
    return this.penalties.overridePenalty(admin.id, penaltyId, dto.adminNote)
  }

  @Get('disputes')
  @ApiOperation({ summary: 'List open no-show disputes' })
  disputes(@Query('page') page?: number) {
    return this.penalties.listDisputes(page)
  }

  @Put('disputes/:id/resolve')
  @ApiOperation({ summary: 'Resolve dispute — restored_cleared gives back 20 pts' })
  resolve(
    @CurrentAdmin() admin: AuthAdmin,
    @Param('id') disputeId: string,
    @Body() dto: ResolveDisputeDto,
  ) {
    return this.penalties.resolveDispute(admin.id, disputeId, dto.resolution)
  }
}

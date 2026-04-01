import {
  Controller, Get, Put, Param, Query, Body, UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { IsString, IsNotEmpty, IsOptional, IsIn } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { AdminVenuesService } from './admin-venues.service.js'
import { AdminJwtGuard } from '../../common/guards/admin-jwt.guard.js'
import { RolesGuard, Roles } from '../../common/guards/roles.guard.js'
import { CurrentAdmin } from '../../common/decorators/current-admin.decorator.js'
import type { AuthAdmin } from '../../common/guards/admin-jwt.guard.js'

class RejectVenueDto {
  @ApiProperty() @IsString() @IsNotEmpty() reason!: string
}

class GetDocQueryDto {
  @ApiPropertyOptional({ enum: ['citizenship', 'pan', 'business_reg', 'other'] })
  @IsOptional()
  @IsIn(['citizenship', 'pan', 'business_reg', 'other'])
  docType?: string
}

@ApiTags('Admin — Venues')
@ApiBearerAuth('Admin-JWT')
@UseGuards(AdminJwtGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller()
export class AdminVenuesController {
  constructor(private readonly adminVenues: AdminVenuesService) {}

  @Get('venues/pending')
  @ApiOperation({ summary: 'List venues pending verification' })
  pending(@Query('page') page?: number) {
    return this.adminVenues.listPendingVenues(page)
  }

  @Get('venues/flagged')
  @ApiOperation({ summary: 'List flagged venues' })
  flagged(@Query('page') page?: number) {
    return this.adminVenues.listFlaggedVenues(page)
  }

  @Put('venues/:id/verify')
  @ApiOperation({ summary: 'Verify venue' })
  verify(@CurrentAdmin() admin: AuthAdmin, @Param('id') venueId: string) {
    return this.adminVenues.verifyVenue(admin.id, venueId)
  }

  @Put('venues/:id/reject')
  @ApiOperation({ summary: 'Reject venue with reason' })
  reject(
    @CurrentAdmin() admin: AuthAdmin,
    @Param('id') venueId: string,
    @Body() dto: RejectVenueDto,
  ) {
    return this.adminVenues.rejectVenue(admin.id, venueId, dto.reason)
  }

  @Get('owners/:id/docs')
  @ApiOperation({ summary: 'Get presigned R2 GET URL for owner verification doc (10 min)' })
  ownerDocs(
    @Param('id') ownerId: string,
    @Query() query: GetDocQueryDto,
  ) {
    return this.adminVenues.getOwnerDocUrl(ownerId, query.docType ?? 'citizenship')
  }
}

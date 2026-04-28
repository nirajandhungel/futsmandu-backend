// owner-api/src/modules/venue-management/venue-management.controller.ts
// Gallery endpoint removed — use GET /media/venues/:venueId/gallery (MediaController)
// which includes presigned URLs and a 50-min in-memory cache.
// All media uploads go through /media/* (media.controller.ts).

import {
  Controller, Get, Post, Put, Delete, Body, Param, UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { VenueManagementService } from './venue-management.service.js'
import {
  CreateVenueDto, UpdateVenueDto, CreateCourtDto, UpdateCourtDto,
} from './dto/venue.dto.js'
import { OwnerJwtGuard } from '../../common/guards/owner-jwt.guard.js'
import { RolesGuard, Roles } from '../../common/guards/roles.guard.js'
import { CurrentOwner } from '../../common/decorators/current-owner.decorator.js'
import type { AuthOwner } from '../../common/guards/owner-jwt.guard.js'

@ApiTags('Venue Management')
@ApiBearerAuth('Owner-JWT')
@UseGuards(OwnerJwtGuard, RolesGuard)
@Controller('venues')
export class VenueManagementController {
  constructor(private readonly venues: VenueManagementService) {}

  @Get()
  @ApiOperation({ summary: 'List owner venues' })
  list(@CurrentOwner() owner: AuthOwner) {
    return this.venues.listVenues(owner.id)
  }

  @Post()
  @ApiOperation({ summary: 'Create venue' })
  create(@CurrentOwner() owner: AuthOwner, @Body() dto: CreateVenueDto) {
    return this.venues.createVenue(owner.id, dto)
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update venue' })
  update(@CurrentOwner() owner: AuthOwner, @Param('id') id: string, @Body() dto: UpdateVenueDto) {
    return this.venues.updateVenue(owner.id, id, dto)
  }

  @Get(':id/courts')
  @ApiOperation({ summary: 'List courts for a venue' })
  listCourts(@CurrentOwner() owner: AuthOwner, @Param('id') id: string) {
    return this.venues.listCourts(owner.id, id)
  }

  @Post(':id/courts')
  @ApiOperation({ summary: 'Create court with mandatory base pricing rule' })
  createCourt(
    @CurrentOwner() owner: AuthOwner,
    @Param('id') id: string,
    @Body() dto: CreateCourtDto,
  ) {
    return this.venues.createCourt(owner.id, id, dto)
  }

  // Gallery removed — use GET /media/venues/:venueId/gallery (MediaController)
  // That endpoint returns presigned signedUrl + thumbUrl with a 50-min in-memory cache.
}

@ApiTags('Venue Management')
@ApiBearerAuth('Owner-JWT')
@UseGuards(OwnerJwtGuard, RolesGuard)
@Controller('courts')
export class CourtsController {
  constructor(private readonly venues: VenueManagementService) {}

  @Put(':id')
  @ApiOperation({ summary: 'Update court settings' })
  update(@CurrentOwner() owner: AuthOwner, @Param('id') id: string, @Body() dto: UpdateCourtDto) {
    return this.venues.updateCourt(owner.id, id, dto)
  }

  @Delete(':id')
  @Roles('OWNER_ADMIN')
  @ApiOperation({ summary: 'Soft delete court (is_active = false)' })
  delete(@CurrentOwner() owner: AuthOwner, @Param('id') id: string) {
    return this.venues.softDeleteCourt(owner.id, id)
  }
}

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
import { CurrentOwner, } from '../../common/decorators/current-owner.decorator.js'
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
  @ApiOperation({ summary: 'Create court' })
  createCourt(@CurrentOwner() owner: AuthOwner, @Param('id') id: string, @Body() dto: CreateCourtDto) {
    return this.venues.createCourt(owner.id, id, dto)
  }

  @Post(':id/images/upload-url')
  @ApiOperation({ summary: 'Get presigned R2 PUT URL for cover image' })
  imageUploadUrl(@CurrentOwner() owner: AuthOwner, @Param('id') id: string) {
    return this.venues.getImageUploadUrl(owner.id, id)
  }
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

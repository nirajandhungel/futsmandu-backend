// apps/api-owner/src/modules/bookings/bookings.controller.ts
import {
  Controller, Get, Post, Put, Body, Param, Query, UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { BookingsService } from './bookings.service.js'
import {
  CreateOfflineBookingDto,
  ListBookingsQueryDto, MarkAttendanceDto,
} from './dto/booking.dto.js'
import { OwnerJwtGuard } from '../../common/guards/owner-jwt.guard.js'
import { RolesGuard } from '../../common/guards/roles.guard.js'
import { CurrentOwner } from '../../common/decorators/current-owner.decorator.js'
import type { AuthOwner } from '../../common/guards/owner-jwt.guard.js'

@ApiTags('Bookings')
@ApiBearerAuth('Owner-JWT')
@UseGuards(OwnerJwtGuard, RolesGuard)
@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  // Calendar removed — use GET /courts/:courtId/calendar (CourtsService)
  // That endpoint includes Redis holds, player names, bookingId, and pricing.

  @Post('offline')
  @ApiOperation({ summary: 'Create walk-in offline booking' })
  createOffline(@CurrentOwner() owner: AuthOwner, @Body() dto: CreateOfflineBookingDto) {
    // owner.id used for both ownerId (venue scoping) and staffId (created_by_owner_id)
    return this.bookings.createOfflineBooking(owner.id, owner.id, dto)
  }

  @Get()
  @ApiOperation({ summary: 'List bookings with filters' })
  list(@CurrentOwner() owner: AuthOwner, @Query() query: ListBookingsQueryDto) {
    return this.bookings.listBookings(owner.id, query)
  }

  @Put(':id/attendance')
  @ApiOperation({ summary: 'Mark no-shows for a booking' })
  markAttendance(
    @CurrentOwner() owner: AuthOwner,
    @Param('id') bookingId: string,
    @Body() dto: MarkAttendanceDto,
  ) {
    return this.bookings.markAttendance(owner.id, owner.id, bookingId, dto.no_show_ids)
  }
}
import {
  Controller, Get, Post, Put, Body, Param, Query, UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { BookingsService } from './bookings.service.js'
import {
  CalendarQueryDto, CreateOfflineBookingDto,
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

  @Get('courts/:id/calendar')
  @ApiOperation({ summary: 'Slot calendar for a court on a date' })
  calendar(
    @CurrentOwner() owner: AuthOwner,
    @Param('id') courtId: string,
    @Query() query: CalendarQueryDto,
  ) {
    return this.bookings.getCalendar(owner.id, courtId, query.date)
  }

  @Post('offline')
  @ApiOperation({ summary: 'Create walk-in offline booking' })
  createOffline(@CurrentOwner() owner: AuthOwner, @Body() dto: CreateOfflineBookingDto) {
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

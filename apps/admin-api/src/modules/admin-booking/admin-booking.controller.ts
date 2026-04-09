import {
  Controller, Get, Put, Param, Query, Body, UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { AdminBookingService } from './admin-booking.service.js'
import { AdminJwtGuard } from '../../common/guards/admin-jwt.guard.js'
import { RolesGuard, Roles } from '../../common/guards/roles.guard.js'
import { CurrentAdmin } from '../../common/decorators/current-admin.decorator.js'
import { ListBookingsQueryDto, BookingOverviewQueryDto } from './dto/booking.dto.js'
import type { AuthAdmin } from '../../common/guards/admin-jwt.guard.js'

@ApiTags('Admin - Bookings')
@ApiBearerAuth('Admin-JWT')
@UseGuards(AdminJwtGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('bookings')
export class AdminBookingController {
  constructor(private readonly adminBooking: AdminBookingService) {}

  @Get()
  @ApiOperation({ summary: 'List bookings with filters' })
  list(@Query() query: ListBookingsQueryDto) {
    return this.adminBooking.listBookings(query)
  }

  @Get('stats/overview')
  @ApiOperation({ summary: 'Booking overview stats for admin dashboard' })
  overview(@Query() query: BookingOverviewQueryDto) {
    return this.adminBooking.getOverview(query)
  }

}

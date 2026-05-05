import {
  Controller, Get, Patch, Param, Query, UseGuards, ParseUUIDPipe,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { AdminBookingService } from './admin-booking.service.js'
import { AdminJwtGuard } from '../../common/guards/jwt.guard.js'
import { RolesGuard, Roles } from '../../common/guards/roles.guard.js'
import { CurrentAdmin } from '../../common/decorators/user.decorator.js'
import { ListBookingsQueryDto, BookingOverviewQueryDto } from './dto/booking.dto.js'

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

  @Get(':id')
  @ApiOperation({ summary: 'Full booking detail with deposit, remaining, payment and payout info' })
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminBooking.getBookingDetail(id)
  }

  @Patch(':id/complete')
  @ApiOperation({ summary: 'Mark a confirmed booking as completed (enables payout processing)' })
  markCompleted(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: { id: string },
  ) {
    return this.adminBooking.markBookingCompleted(id, admin.id)
  }
}
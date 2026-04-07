import {
  Controller, Get, Put, Param, Query, Body, UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import {
  IsOptional, IsString, IsEnum, IsDateString, IsUUID,
  IsInt, Min, Max, MaxLength,
} from 'class-validator'
import { ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { booking_status } from '@futsmandu/database'
import { AdminBookingService } from './admin-booking.service.js'
import { AdminJwtGuard } from '../../common/guards/admin-jwt.guard.js'
import { RolesGuard, Roles } from '../../common/guards/roles.guard.js'
import { CurrentAdmin } from '../../common/decorators/current-admin.decorator.js'
import type { AuthAdmin } from '../../common/guards/admin-jwt.guard.js'

class ListBookingsQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number

  @ApiPropertyOptional({ enum: booking_status })
  @IsOptional()
  @IsEnum(booking_status)
  status?: booking_status

  @ApiPropertyOptional({ description: 'Filter by venue UUID' })
  @IsOptional()
  @IsUUID('4')
  venueId?: string

  @ApiPropertyOptional({ description: 'Filter by player UUID' })
  @IsOptional()
  @IsUUID('4')
  playerId?: string

  @ApiPropertyOptional({ example: '2026-04-07' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string

  @ApiPropertyOptional({ example: '2026-04-30' })
  @IsOptional()
  @IsDateString()
  dateTo?: string

  @ApiPropertyOptional({ description: 'Search by booking id, player name/email/phone, venue name' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string
}

class CancelBookingByAdminDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string
}

class BookingOverviewQueryDto {
  @ApiPropertyOptional({ example: '2026-04-01' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string

  @ApiPropertyOptional({ example: '2026-04-30' })
  @IsOptional()
  @IsDateString()
  dateTo?: string

  @ApiPropertyOptional({ description: 'Optional venue UUID filter' })
  @IsOptional()
  @IsUUID('4')
  venueId?: string
}

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
  @ApiOperation({ summary: 'Get booking detail' })
  detail(@Param('id') bookingId: string) {
    return this.adminBooking.getBookingDetail(bookingId)
  }

  @Put(':id/cancel')
  @ApiOperation({ summary: 'Cancel booking as admin' })
  cancel(
    @CurrentAdmin() admin: AuthAdmin,
    @Param('id') bookingId: string,
    @Body() dto: CancelBookingByAdminDto,
  ) {
    return this.adminBooking.cancelBooking(admin.id, bookingId, dto.reason)
  }
}

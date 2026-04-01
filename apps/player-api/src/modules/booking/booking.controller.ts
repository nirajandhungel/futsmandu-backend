// CHANGED: [SEC-1 rate limit on availability, SEC-2 BookingQueryDto, SEC-5 status masking for public]
// NEW ISSUES FOUND:
//   - getBookings passed raw query params without DTO — strings reached service arithmetic (SEC-2)
//   - getAvailability had no rate limit or cache headers on a public, unauthenticated endpoint (SEC-1)
//   - Slot grid returned internal statuses (HELD, PENDING_PAYMENT) to unauthenticated callers (SEC-5)

// apps/player-api/src/modules/booking/booking.controller.ts
import {
  Controller, Post, Get, Body, Param, Query,
  ParseUUIDPipe, HttpCode, HttpStatus, Res,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import type { FastifyReply } from 'fastify'
import { BookingService } from './booking.service.js'
import { HoldSlotDto, CancelBookingDto, BookingQueryDto } from './dto/booking.dto.js'
import { CurrentUser, Public } from '@futsmandu/auth'
import type { AuthenticatedUser } from '@futsmandu/types'

@ApiTags('Bookings')
@ApiBearerAuth()
@Controller()
export class BookingController {
  constructor(private readonly bookingService: BookingService) { }

  // GET /venues/:id/availability?courtId=&date=
  // SEC-1: Public endpoint — rate-limited + CDN cache headers to prevent scraping
  // SEC-5: Status values simplified for unauthenticated callers
  @Public()
  @Get('venues/:id/availability')
  @Throttle({ default: { limit: 60, ttl: 60000 } }) // 60 req/min per IP
  @ApiOperation({ summary: 'Slot availability grid for a court on a date' })
  async getAvailability(
    @Param('id', ParseUUIDPipe) _venueId: string,
    @Query('courtId', ParseUUIDPipe) courtId: string,
    @Query('date') date: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    // SEC-1: 30-second CDN cache; stale content served for up to 60s during revalidation
    reply.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60')

    const grid = await this.bookingService.getSlotGrid(courtId, date)

    // SEC-5: Public callers only see AVAILABLE vs UNAVAILABLE — no internal state leakage
    return grid.map(slot => ({
      ...slot,
      status: slot.status === 'AVAILABLE' ? 'AVAILABLE' : 'UNAVAILABLE',
    }))
  }

  // POST /bookings/hold
  @Post('bookings/hold')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Hold a slot (advisory lock + SERIALIZABLE transaction)' })
  holdSlot(@CurrentUser() user: AuthenticatedUser, @Body() dto: HoldSlotDto) {
    return this.bookingService.holdSlot(user.id, dto)
  }

  // GET /bookings
  // SEC-2: Typed DTO with @Type(() => Number) prevents string arithmetic bugs
  @Get('bookings')
  @ApiOperation({ summary: 'Paginated booking history' })
  getBookings(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BookingQueryDto,
  ) {
    return this.bookingService.getBookings(user.id, query)
  }

  // GET /bookings/:id
  @Get('bookings/:id')
  @ApiOperation({ summary: 'Booking detail' })
  getBooking(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.bookingService.getBooking(id, user.id)
  }

  // POST /bookings/:id/cancel
  @Post('bookings/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel confirmed booking (refund policy applied)' })
  cancelBooking(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CancelBookingDto,
  ) {
    return this.bookingService.cancelBooking(id, user.id, dto.reason)
  }
}

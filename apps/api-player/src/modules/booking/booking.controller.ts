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
import {
  HoldSlotDto, CancelBookingDto, BookingQueryDto, RequestJoinDto,
  RespondJoinRequestDto, AddFriendToMatchDto, OpenMatchesQueryDto,
} from './dto/booking.dto.js'
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
      status: String(slot.status) === 'AVAILABLE'
        ? 'AVAILABLE'
        : String(slot.status) === 'OPEN_TO_JOIN'
          ? 'OPEN_TO_JOIN'
          : 'UNAVAILABLE',
    }))
  }

  // POST /bookings/hold
  @Post('bookings/hold')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Hold a slot (advisory lock + SERIALIZABLE transaction)' })
  holdSlot(@CurrentUser() user: AuthenticatedUser, @Body() dto: HoldSlotDto) {
    return this.bookingService.holdSlot(user.id, dto)
  }

  // POST /bookings/:id/join
  @Post('bookings/:id/join')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Join an open slot in an existing booking' })
  joinBookingSlot(@Param('id', ParseUUIDPipe) bookingId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.bookingService.joinBookingSlot(bookingId, user.id)
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

  @Post('matches/join')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Request to join an open match' })
  requestJoinMatch(@CurrentUser() user: AuthenticatedUser, @Body() dto: RequestJoinDto) {
    return this.bookingService.requestJoinMatch(user.id, dto)
  }

  @Post('matches/join-requests/:id/respond')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept or reject a match join request' })
  respondJoinRequest(
    @Param('id', ParseUUIDPipe) requestId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RespondJoinRequestDto,
  ) {
    return this.bookingService.respondToJoinRequest(user.id, { ...dto, requestId })
  }

  @Post('matches/:id/members/add-friend')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a friend directly to your match' })
  addFriendToMatch(
    @Param('id', ParseUUIDPipe) matchGroupId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddFriendToMatchDto,
  ) {
    return this.bookingService.addFriendToMatch(user.id, { ...dto, matchGroupId })
  }

  @Public()
  @Get('matches')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: 'List open matches with available spots' })
  getOpenMatches(@Query() query: OpenMatchesQueryDto) {
    return this.bookingService.getOpenMatches(query)
  }

  @Get('matches/:id/members')
  @ApiOperation({ summary: 'Get match members' })
  getMatchMembers(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.bookingService.getMatchMembers(id, user.id)
  }
}

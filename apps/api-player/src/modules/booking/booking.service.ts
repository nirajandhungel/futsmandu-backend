// api-player/src/modules/booking/booking.service.ts
import { Injectable } from '@nestjs/common'
import type {
  HoldSlotDto, BookingQueryDto, RequestJoinDto, RespondJoinRequestDto,
  AddFriendToMatchDto, OpenMatchesQueryDto,
} from './dto/booking.dto.js'
import type { GatewayVerification } from '@futsmandu/types'
import { BookingLifecycleService } from './booking-lifecycle.service.js'
import { BookingMatchService } from './booking-match.service.js'

@Injectable()
export class BookingService {
  constructor(
    private readonly lifecycle: BookingLifecycleService,
    private readonly matchFlow: BookingMatchService,
  ) {}

  holdSlot(playerId: string, dto: HoldSlotDto) { return this.lifecycle.holdSlot(playerId, dto) }
  
  confirmPayment(bookingId: string, verified: GatewayVerification, gateway: 'KHALTI' | 'ESEWA') { return this.lifecycle.confirmPayment(bookingId, verified, gateway) }
  initiatePayment(bookingId: string, gateway: 'KHALTI' | 'ESEWA', playerId: string) { return this.lifecycle.initiatePayment(bookingId, gateway, playerId) }
  cancelBooking(bookingId: string, cancelledBy: string, reason?: string) { return this.lifecycle.cancelBooking(bookingId, cancelledBy, reason) }
  expireBooking(bookingId: string) { return this.lifecycle.expireBooking(bookingId) }
  getSlotGrid(courtId: string, date: string) { return this.lifecycle.getSlotGrid(courtId, date) }
  getBookings(playerId: string, query: BookingQueryDto) { return this.lifecycle.getBookings(playerId, query) }
  getBooking(bookingId: string, playerId: string) { return this.lifecycle.getBooking(bookingId, playerId) }
  joinBookingSlot(bookingId: string, playerId: string, position?: string) { return this.matchFlow.joinBookingSlot(bookingId, playerId, position) }

  requestJoinMatch(playerId: string, dto: RequestJoinDto) { return this.matchFlow.requestJoinMatch(playerId, dto) }
  respondToJoinRequest(adminId: string, dto: RespondJoinRequestDto) { return this.matchFlow.respondToJoinRequest(adminId, dto) }
  addFriendToMatch(adminId: string, dto: AddFriendToMatchDto) { return this.matchFlow.addFriendToMatch(adminId, dto) }
  getOpenMatches(query: OpenMatchesQueryDto) { return this.matchFlow.getOpenMatches(query) }
  getMatchMembers(matchGroupId: string, requesterId: string) { return this.matchFlow.getMatchMembers(matchGroupId, requesterId) }
}
// CHANGED: [C-6 GREATEST(0,...) atomic floor, H-4 N+1 calendar pricing, SEC-6 start_time format, PERF-2/3]
// NEW ISSUES FOUND:
//   - markAttendance used { decrement: 20 } which can go below 0 under concurrency (C-6)
//   - getCalendar called calculatePrice per slot in a loop (N+1 — H-4/PERF-3)
//   - listBookings fetched all venueIds in a separate query then used { in: [...] } (PERF-2)
//   - CreateOfflineBookingDto.start_time had no format validation (SEC-6)

// apps/owner-admin-api/src/modules/bookings/bookings.service.ts
// Offline bookings, calendar, attendance marking.
// C-6: reliability_score decremented with raw SQL GREATEST(0, score - 20).
// H-4: Pricing rules fetched ONCE per court, then calculatePriceFromRules used in loop.
// PERF-2: Venue scoping via relation filter (WHERE EXISTS subquery) not extra round-trip.

import {
  Injectable, NotFoundException, BadRequestException, Logger,
} from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import {
  calculatePrice, calculatePriceFromRules, addMinutesToTime, formatPaisa,
} from '@futsmandu/utils'
import type { PricingRule } from '@futsmandu/utils'
import type { CreateOfflineBookingDto, ListBookingsQueryDto } from './dto/booking.dto.js'
import type { SlotGridItem } from '@futsmandu/types'

type ActiveStatus = 'HELD' | 'PENDING_PAYMENT' | 'CONFIRMED'

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name)

  constructor(private readonly prisma: PrismaService) {}

  // ── Calendar — full slot grid with booking overlay ────────────────────────
  // H-4: Pricing rules fetched ONCE before the slot loop.
  // PERF-3: calculatePriceFromRules (pure, no DB) used inside the loop.
  async getCalendar(ownerId: string, courtId: string, date: string): Promise<SlotGridItem[]> {
    const court = await this.prisma.courts.findFirst({
      where: {
        id:        courtId,
        is_active: true,
        venue:     { owner_id: ownerId },
      },
      select: { open_time: true, close_time: true, slot_duration_mins: true },
    })
    if (!court) throw new NotFoundException('Court not found or access denied')

    const slots: SlotGridItem[] = []
    let cursor = court.open_time
    while (cursor < court.close_time) {
      const endTime = addMinutesToTime(cursor, court.slot_duration_mins)
      if (endTime > court.close_time) break
      slots.push({ startTime: cursor, endTime, status: 'AVAILABLE' })
      cursor = endTime
    }

    // H-4: Fetch all active pricing rules for this court ONCE — no per-slot DB call
    const [existingBookings, pricingRules] = await Promise.all([
      this.prisma.bookings.findMany({
        where: {
          court_id:     courtId,
          booking_date: new Date(date),
          status:       { in: ['HELD', 'PENDING_PAYMENT', 'CONFIRMED'] as ActiveStatus[] },
        },
        select: { start_time: true, status: true },
      }),
      this.prisma.pricing_rules.findMany({
        where: { court_id: courtId, is_active: true },
        orderBy: { priority: 'desc' },
      }),
    ])

    const bookingMap = new Map<string, any>(existingBookings.map((b: any) => [b.start_time, b.status]))

    for (const slot of slots) {
      const match = bookingMap.get(slot.startTime)
      if (match) slot.status = match as SlotGridItem['status']

      // PERF-3: Pure calculation — no DB round-trip per slot
      if (pricingRules.length > 0) {
        try {
          const pricing    = calculatePriceFromRules(pricingRules as PricingRule[], date, slot.startTime)
          slot.price        = pricing.price
          slot.displayPrice = formatPaisa(pricing.price)
        } catch {
          // Court has pricing rules but none match this slot — leave price undefined
        }
      }
    }

    return slots
  }

  // ── Create offline booking ────────────────────────────────────────────────
  async createOfflineBooking(
    ownerId: string,
    staffId: string,
    dto: CreateOfflineBookingDto,
  ) {
    const court = await this.prisma.courts.findFirst({
      where: {
        id:        dto.court_id,
        is_active: true,
        venue:     { owner_id: ownerId },
      },
      select: {
        id: true, venue_id: true,
        slot_duration_mins: true, open_time: true, close_time: true,
      },
    })
    if (!court) throw new NotFoundException('Court not found or access denied')

    if (dto.start_time < court.open_time || dto.start_time >= court.close_time) {
      throw new BadRequestException(
        `Start time ${dto.start_time} is outside court hours (${court.open_time}–${court.close_time})`,
      )
    }

    const endTime = addMinutesToTime(dto.start_time, court.slot_duration_mins)

    let totalAmount   = 0
    let appliedRuleId: string | null = null
    try {
      const pricing = await calculatePrice(
        this.prisma, dto.court_id, dto.booking_date, dto.start_time,
      )
      totalAmount   = pricing.price
      appliedRuleId = pricing.ruleId
    } catch {
      this.logger.warn(`No pricing rule for court ${dto.court_id} — booking at 0 price`)
    }

    const booking = await this.prisma.bookings.create({
      data: {
        booking_type:           dto.booking_type as 'offline_cash' | 'offline_paid' | 'offline_reserved',
        player_id:              null,
        court_id:               dto.court_id,
        venue_id:               court.venue_id,
        booking_date:           new Date(dto.booking_date),
        start_time:             dto.start_time,
        end_time:               endTime,
        duration_mins:          court.slot_duration_mins,
        total_amount:           totalAmount,
        base_price:             totalAmount,
        applied_rule_id:        appliedRuleId,
        status:                 'CONFIRMED',
        offline_customer_name:  dto.customer_name,
        offline_customer_phone: dto.customer_phone,
        offline_notes:          dto.notes ?? null,
        created_by:             staffId,
      },
      select: {
        id: true, booking_type: true, status: true,
        start_time: true, end_time: true, booking_date: true,
        total_amount: true, offline_customer_name: true,
      },
    })

    this.logger.log(`Offline booking created: ${booking.id} by staff ${staffId}`)
    return booking
  }

  // ── List bookings with filters ────────────────────────────────────────────
  // PERF-2: Use Prisma relation filter (generates WHERE EXISTS) instead of
  //         fetching all venueIds first in a separate round-trip.
  async listBookings(ownerId: string, query: ListBookingsQueryDto) {
    const PAGE_SIZE = 20
    const page      = Math.max(1, query.page ?? 1)
    const skip      = (page - 1) * PAGE_SIZE

    const where = {
      // Scopes to this owner's venues via a WHERE EXISTS subquery — single DB round-trip
      venue: { owner_id: ownerId },
      ...(query.date    ? { booking_date: new Date(query.date) } : {}),
      ...(query.courtId ? { court_id: query.courtId }            : {}),
      ...(query.status  ? { status: query.status as Parameters<typeof this.prisma.bookings.findMany>[0] extends { where?: { status?: infer S } } ? S : never } : {}),
    }

    const [bookings, total] = await Promise.all([
      this.prisma.bookings.findMany({
        where,
        select: {
          id: true, booking_type: true, status: true,
          booking_date: true, start_time: true, end_time: true,
          total_amount: true, offline_customer_name: true,
          offline_customer_phone: true, created_at: true,
          player: { select: { id: true, name: true, phone: true } },
          court:  { select: { id: true, name: true } },
          venue:  { select: { id: true, name: true } },
        },
        orderBy: [{ booking_date: 'desc' }, { start_time: 'asc' }],
        skip,
        take: PAGE_SIZE,
      }),
      this.prisma.bookings.count({ where }),
    ])

    return {
      data: bookings,
      meta: {
        page,
        limit:      PAGE_SIZE,
        total,
        totalPages: Math.ceil(total / PAGE_SIZE),
      },
    }
  }

  // ── Mark attendance / no-shows ────────────────────────────────────────────
  // C-6: Uses raw SQL GREATEST(0, reliability_score - 20) to atomically floor at 0.
  //      Prisma { decrement: 20 } is not safe under concurrent no-show marking.
  async markAttendance(
    ownerId: string,
    staffId: string,
    bookingId: string,
    noShowIds: string[],
  ) {
    const booking = await this.prisma.bookings.findFirst({
      where: {
        id:     bookingId,
        venue:  { owner_id: ownerId },
        status: { in: ['CONFIRMED', 'COMPLETED'] },
      },
      select: { id: true, player_id: true, booking_date: true },
    })
    if (!booking) throw new NotFoundException('Booking not found or access denied')

    const slotDate = new Date(booking.booking_date)
    const today    = new Date()
    today.setHours(0, 0, 0, 0)
    if (slotDate >= today) {
      throw new BadRequestException('Can only mark attendance for past bookings')
    }

    await this.prisma.$transaction(async (tx: any) => {
      for (const playerId of noShowIds) {
        const existing = await tx.no_show_logs.findFirst({
          where:  { player_id: playerId, booking_id: bookingId },
          select: { id: true },
        })
        if (existing) continue

        await tx.no_show_logs.create({
          data: {
            player_id:      playerId,
            booking_id:     bookingId,
            marked_by:      staffId,
            marked_by_type: 'owner',
          },
        })

        // C-6: Raw SQL GREATEST prevents reliability_score going below 0
        // even under concurrent no-show marking of the same player.
        await tx.$executeRaw`
          UPDATE users
          SET
            reliability_score = GREATEST(0, reliability_score - 20),
            total_no_shows    = total_no_shows + 1,
            updated_at        = NOW()
          WHERE id = ${playerId}::uuid`
      }

      await tx.bookings.update({
        where: { id: bookingId },
        data:  { status: 'COMPLETED', updated_at: new Date() },
      })
    })

    return { message: 'Attendance recorded', noShowCount: noShowIds.length }
  }
}

// apps/owner-api/src/modules/courts/courts.service.ts
// Court availability and block management for owners.
// Slot grid: merges DB bookings + Redis holds for real-time calendar view.
import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import { RedisService } from '@futsmandu/redis'
import { addMinutesToTime, formatPaisa, calculatePriceFromRules } from '@futsmandu/utils'
import type { PricingRule } from '@futsmandu/utils'

@Injectable()
export class CourtsService {
  private readonly logger = new Logger(CourtsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ── Full slot calendar with live booking overlay ──────────────────────────
  // Merges DB bookings, Redis holds, and pricing rules into one grid.
  // Used by Flutter owner app for the court calendar screen.
  async getCourtCalendar(ownerId: string, courtId: string, date: string) {
    const court = await this.prisma.courts.findFirst({
      where: { id: courtId, is_active: true, venue: { owner_id: ownerId } },
      select: { open_time: true, close_time: true, slot_duration_mins: true },
    })
    if (!court) throw new NotFoundException('Court not found or access denied')

    // Build time slots
    const slots: Array<{
      startTime: string
      endTime: string
      status: string
      price?: number
      displayPrice?: string
      bookingId?: string
      playerName?: string
      bookingType?: string
    }> = []

    let cursor = court.open_time
    while (cursor < court.close_time) {
      const endTime = addMinutesToTime(cursor, court.slot_duration_mins)
      if (endTime > court.close_time) break
      slots.push({ startTime: cursor, endTime, status: 'AVAILABLE' })
      cursor = endTime
    }

    // Fetch bookings + pricing in parallel
    const [bookings, pricingRules] = await Promise.all([
      this.prisma.bookings.findMany({
        where: {
          court_id:     courtId,
          booking_date: new Date(date),
          status:       { in: ['HELD', 'PENDING_PAYMENT', 'CONFIRMED'] },
        },
        select: {
          id: true, start_time: true, status: true, booking_type: true,
          player: { select: { name: true } },
          offline_customer_name: true,
        },
      }),
      this.prisma.pricing_rules.findMany({
        where: { court_id: courtId, is_active: true },
        orderBy: { priority: 'desc' },
      }),
    ])

    // Batch-fetch Redis holds (single MGET round-trip)
    const redisKeys = slots.map(s => `hold:${courtId}:${date}:${s.startTime}`)
    const redisVals = redisKeys.length > 0
      ? await this.redis.client.mget(...redisKeys)
      : []

    const bookingMap = new Map<string, any>(bookings.map((b: any) => [b.start_time, b]))

    for (let i = 0; i < slots.length; i++) {
      const slot    = slots[i]!
      const booking = bookingMap.get(slot.startTime)
      const held    = redisVals[i]

      if (booking) {
        slot.status      = booking.status
        slot.bookingId   = booking.id
        slot.playerName  = booking.player?.name ?? booking.offline_customer_name ?? 'Walk-in'
        slot.bookingType = booking.booking_type
      } else if (held) {
        slot.status = 'HELD'
      }

      // Add pricing — pure calculation, no DB hit
      if (pricingRules.length > 0) {
        try {
          const pricing      = calculatePriceFromRules(pricingRules as PricingRule[], date, slot.startTime)
          slot.price         = pricing.price
          slot.displayPrice  = formatPaisa(pricing.price)
        } catch {
          // No rule matches this slot — leave price undefined
        }
      }
    }

    return { date, courtId, slots }
  }

  // ── Block a court slot (maintenance, private use) ─────────────────────────
  async blockSlot(
    ownerId: string,
    courtId: string,
    date: string,
    startTime: string,
    reason?: string,
  ) {
    const court = await this.prisma.courts.findFirst({
      where: { id: courtId, is_active: true, venue: { owner_id: ownerId } },
      select: { venue_id: true, slot_duration_mins: true, close_time: true },
    })
    if (!court) throw new NotFoundException('Court not found or access denied')

    const endTime = addMinutesToTime(startTime, court.slot_duration_mins)

    // Check for existing active booking
    const existing = await this.prisma.bookings.findFirst({
      where: {
        court_id:     courtId,
        booking_date: new Date(date),
        start_time:   startTime,
        status:       { in: ['HELD', 'PENDING_PAYMENT', 'CONFIRMED'] },
      },
      select: { id: true, status: true },
    })
    if (existing) {
      throw new BadRequestException(`Slot already has an active booking (${existing.status})`)
    }

    const block = await this.prisma.bookings.create({
      data: {
        booking_type:  'offline_reserved',
        player_id:     null,
        court_id:      courtId,
        venue_id:      court.venue_id,
        booking_date:  new Date(date),
        start_time:    startTime,
        end_time:      endTime,
        duration_mins: court.slot_duration_mins,
        total_amount:  0,
        base_price:    0,
        status:        'CONFIRMED',
        offline_notes: reason ?? 'Blocked by owner',
        created_by:    ownerId,
      },
      select: { id: true, start_time: true, end_time: true, status: true },
    })

    this.logger.log(`Slot blocked: court ${courtId} ${date} ${startTime} by owner ${ownerId}`)
    return block
  }

  // ── Unblock a slot ─────────────────────────────────────────────────────────
  async unblockSlot(ownerId: string, blockId: string) {
    const block = await this.prisma.bookings.findFirst({
      where: {
        id:           blockId,
        booking_type: 'offline_reserved',
        venue:        { owner_id: ownerId },
        status:       'CONFIRMED',
      },
      select: { id: true },
    })
    if (!block) throw new NotFoundException('Block not found or access denied')

    await this.prisma.bookings.update({
      where: { id: blockId },
      data:  { status: 'CANCELLED', cancelled_at: new Date(), cancelled_by: ownerId },
    })

    return { message: 'Slot unblocked' }
  }
}

// apps/owner-api/src/modules/courts/courts.service.ts
// Court availability and block management for owners.
// Slot grid: merges DB bookings + Redis holds for real-time calendar view.
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "@futsmandu/database";
import { RedisService } from "@futsmandu/redis";
import {
  addMinutesToTime,
  formatPaisa,
  calculatePriceFromRules,
} from "@futsmandu/utils";
import type { PricingRule } from "@futsmandu/utils";
import { BlockSlotDto } from "./dto/block-slot.dto.js";

// Slot calendar row types — used by getCourtCalendar
type CalendarBookingRow = {
  id: string
  start_time: string
  end_time: string
  status: string
  booking_source: string
  offline_customer_name: string | null
  player: { name: string } | null
  match_group: { fill_status: string } | null
}

type CalendarBlockRow = {
  id: string
  start_time: string
  end_time: string
  block_type: string
  note: string | null
}
@Injectable()
export class CourtsService {
  private readonly logger = new Logger(CourtsService.name);

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

  const slots: Array<{
    startTime: string; endTime: string; status: string;
    price?: number; displayPrice?: string;
    bookingId?: string; playerName?: string; bookingType?: string;
    blockId?: string; blockType?: string; note?: string;
  }> = []

  let cursor = court.open_time
  while (cursor < court.close_time) {
    const endTime = addMinutesToTime(cursor, court.slot_duration_mins)
    if (endTime > court.close_time) break
    slots.push({ startTime: cursor, endTime, status: 'AVAILABLE' })
    cursor = endTime
  }

  const [bookings, blocks, pricingRules] = await Promise.all([
    this.prisma.bookings.findMany({
      where: {
        court_id:     courtId,
        booking_date: new Date(date),
        status:       { in: ['HELD', 'PENDING_PAYMENT', 'CONFIRMED'] },
      },
      select: {
        id: true, start_time: true, end_time: true, status: true,
        booking_source: true, offline_customer_name: true,
        player:      { select: { name: true } },
        match_group: { select: { fill_status: true } },
      },
    }) as Promise<CalendarBookingRow[]>,
    this.prisma.court_blocks.findMany({
      where: {
        court_id:     courtId,
        block_date:   new Date(date),
        cancelled_at: null,
        deleted_at:   null,
      },
      select: { id: true, start_time: true, end_time: true, block_type: true, note: true },
    }) as Promise<CalendarBlockRow[]>,
    this.prisma.pricing_rules.findMany({
      where: { court_id: courtId, is_active: true },
      orderBy: { priority: 'desc' },
    }),
  ])

  // Redis holds — single MGET, graceful degrade
  const redisKeys = slots.map((s) => `hold:${courtId}:${date}:${s.startTime}`)
  let redisVals: (string | null)[] = new Array(slots.length).fill(null)
  if (redisKeys.length > 0) {
    try {
      redisVals = await this.redis.client.mget(...redisKeys)
    } catch (err: unknown) {
      this.logger.warn(`Redis unavailable — degraded mode (no live holds): ${(err as Error).message}`)
    }
  }

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!
    const held = redisVals[i]

    // Range overlap: NOT (end <= slotStart OR start >= slotEnd)
    const booking = bookings.find(
      (b: CalendarBookingRow) => b.start_time < slot.endTime && b.end_time > slot.startTime,
    )
    const block = blocks.find(
      (b: CalendarBlockRow) => b.start_time < slot.endTime && b.end_time > slot.startTime,
    )

    if (block) {
      slot.status    = 'BLOCKED'
      slot.blockId   = block.id
      slot.blockType = block.block_type
      slot.note      = block.note ?? undefined
    } else if (booking) {
      slot.status      = booking.status
      slot.bookingId   = booking.id
      slot.playerName  = booking.player?.name ?? booking.offline_customer_name ?? 'Walk-in'
      slot.bookingType = (() => {
        if (booking.booking_source === 'OFFLINE_COUNTER') return 'offline'
        if (!booking.match_group) return 'solo'
        return booking.match_group.fill_status === 'FULL' ? 'full_team' : 'partial_team'
      })()
    } else if (held) {
      slot.status = 'HELD'
    }

    if (pricingRules.length > 0) {
      try {
        const pricing     = calculatePriceFromRules(pricingRules as PricingRule[], date, slot.startTime)
        slot.price        = pricing.price
        slot.displayPrice = formatPaisa(pricing.price)
      } catch {
        // No matching rule for this slot — leave price undefined
      }
    }
  }

  return { date, courtId, slots }
}

  // ── Block a court slot (maintenance, private use, event, personal) ────────
  async blockSlot(ownerId: string, courtId: string, body: BlockSlotDto) {
  const court = await this.prisma.courts.findFirst({
    where: { id: courtId, is_active: true, venue: { owner_id: ownerId } },
    select: { venue_id: true, slot_duration_mins: true, open_time: true, close_time: true },
  })
  if (!court) throw new NotFoundException('Court not found or access denied')

  // Grid alignment — rejects 1:30 on a 60-min grid, etc.
  const [openH, openM] = court.open_time.split(':').map(Number)
  const [startH, startM] = body.startTime.split(':').map(Number)
  const minutesFromOpen = (startH * 60 + startM) - (openH! * 60 + openM!)
  if (minutesFromOpen < 0 || minutesFromOpen % court.slot_duration_mins !== 0) {
    throw new BadRequestException(
      `Start time ${body.startTime} must align to the ${court.slot_duration_mins}-min grid (court opens ${court.open_time})`,
    )
  }

  const endTime = addMinutesToTime(body.startTime, court.slot_duration_mins)

  if (body.startTime < court.open_time || endTime > court.close_time) {
    throw new BadRequestException(
      `Slot ${body.startTime}–${endTime} is outside court hours (${court.open_time}–${court.close_time})`,
    )
  }

  // Range-overlap conflict — catches multi-slot bookings (08:00–10:00 blocks 09:00 too)
  const [bookingConflict, blockConflict] = await Promise.all([
    this.prisma.bookings.findFirst({
      where: {
        court_id:     courtId,
        booking_date: new Date(body.date),
        status:       { in: ['HELD', 'PENDING_PAYMENT', 'CONFIRMED'] },
        start_time:   { lt: endTime },      // booking starts before our slot ends
        end_time:     { gt: body.startTime }, // booking ends after our slot starts
      },
      select: { id: true, status: true },
    }),
    this.prisma.court_blocks.findFirst({
      where: {
        court_id:    courtId,
        block_date:  new Date(body.date),
        cancelled_at: null,
        deleted_at:  null,
        start_time:  { lt: endTime },
        end_time:    { gt: body.startTime },
      },
      select: { id: true, block_type: true },
    }),
  ])

  if (bookingConflict) throw new BadRequestException(`Slot already has an active booking (${bookingConflict.status})`)
  if (blockConflict)   throw new BadRequestException(`Slot already blocked for ${blockConflict.block_type}`)

  const block = await this.prisma.court_blocks.create({
    data: {
      court_id:            courtId,
      venue_id:            court.venue_id,
      block_date:          new Date(body.date),
      start_time:          body.startTime,
      end_time:            endTime,
      block_type:          body.block_type,
      note:                body.note ?? null,
      created_by_owner_id: ownerId,
    },
    select: { id: true, start_time: true, end_time: true, block_type: true, note: true },
  })

  this.logger.log(
    `Slot blocked [${body.block_type}]: court ${courtId} ${body.date} ${body.startTime} by owner ${ownerId}`,
  )

  return {
    blockId:   block.id,
    startTime: block.start_time,
    endTime:   block.end_time,
    status:    'BLOCKED',
    blockType: block.block_type,
    note:      block.note,
  }
}

  // ── Unblock a slot ─────────────────────────────────────────────────────────
  async unblockSlot(ownerId: string, blockId: string) {
  const block = await this.prisma.court_blocks.findFirst({
    where: {
      id:           blockId,
      cancelled_at: null,
      deleted_at:   null,
      court:        { venue: { owner_id: ownerId } },
    },
    select: { id: true },
  })
  if (!block) throw new NotFoundException('Block not found or access denied')

  await this.prisma.court_blocks.update({
    where: { id: blockId },
    data:  { cancelled_at: new Date() },
  })

  return { message: 'Slot unblocked' }
}
}
// CHANGED: [C-4, H-1, H-2, M-2, SEC-1, PgBouncer maxWait/timeout reduction]
// NEW ISSUES FOUND:
//   - confirmPayment emailed to: '' and name: '' (C-4) — fixed: fetch player after commit
//   - cancelBooking discarded refundPct, displayRefund, refundNote (H-1) — now returned
//   - holdSlot had no date range validation — past dates and 30+ day future accepted (H-2)
//   - getBookings cursor used id: { lt: cursor } but ordered by created_at (M-2)
//   - Serializable transaction maxWait: 3000/timeout: 8000 too generous under pool pressure

// apps/player-api/src/modules/booking/booking.service.ts
// ACID-critical booking engine.
// Two concurrency layers:
//   1. pg_try_advisory_xact_lock — non-blocking, returns false instantly if contended
//   2. Partial unique index (idx_bookings_slot_lock) — DB-level hard guarantee
// Redis mirrors DB state for fast O(1) slot-grid reads.

import {
  Injectable, Logger, ConflictException, NotFoundException,
  ForbiddenException, BadRequestException,
} from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { PrismaService } from '@futsmandu/database'
import { RedisService } from '@futsmandu/redis'
import { calculatePrice, addMinutesToTime, hoursUntilSlot, formatPaisa } from '@futsmandu/utils'
import type { SlotGridItem } from '@futsmandu/types'
import type { HoldSlotDto, BookingQueryDto } from './dto/booking.dto.js'
import type { GatewayVerification } from '@futsmandu/types'

// Maximum days in the future a slot can be booked
const MAX_ADVANCE_DAYS = 30

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @InjectQueue('refunds') private readonly refundQueue: Queue,
    @InjectQueue('notifications') private readonly notifQueue: Queue,
    @InjectQueue('analytics') private readonly analyticsQueue: Queue,
    @InjectQueue('player-emails') private readonly emailQueue: Queue,
  ) { }

  // ── Hold Slot ──────────────────────────────────────────────────────────────
  async holdSlot(playerId: string, dto: HoldSlotDto) {
    // H-2: Date range validation BEFORE any DB query
    const slotDate = new Date(dto.date)
    const todayUTC = new Date()
    todayUTC.setUTCHours(0, 0, 0, 0)

    if (isNaN(slotDate.getTime())) throw new BadRequestException('Invalid date format')
    if (slotDate < todayUTC) throw new BadRequestException('Cannot book slots in the past')

    const maxDate = new Date(todayUTC)
    maxDate.setUTCDate(maxDate.getUTCDate() + MAX_ADVANCE_DAYS)
    if (slotDate > maxDate) {
      throw new BadRequestException(`Cannot book more than ${MAX_ADVANCE_DAYS} days in advance`)
    }

    // PRE-CHECKS outside transaction — cheap reads, no locks held
    const user = await this.prisma.users.findUnique({
      where: { id: playerId },
      select: {
        reliability_score: true, ban_until: true,
        is_suspended: true, is_active: true, is_verified: true,
      },
    })

    if (!user?.is_active) throw new NotFoundException('User not found')
    if (!user.is_verified) throw new ForbiddenException('Please verify your email before booking')
    if (user.is_suspended) throw new ForbiddenException('Account suspended — contact support')
    if (user.ban_until && user.ban_until > new Date()) {
      throw new ForbiddenException(`Booking restricted until ${user.ban_until.toISOString()}`)
    }
    if (user.reliability_score < 40) {
      throw new ForbiddenException(`Reliability score too low (${user.reliability_score}/100)`)
    }

    const lockKey = `${dto.courtId}:${dto.date}:${dto.startTime}`

    return this.prisma.$transaction(
      async (tx: any) => {
        const [lock] = await tx.$queryRaw<[{ acquired: boolean }]>`
          SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS acquired`

        if (!lock?.acquired) throw new ConflictException('Slot just taken — choose another time')

        const existing = await tx.bookings.findFirst({
          where: {
            court_id: dto.courtId,
            booking_date: new Date(dto.date),
            start_time: dto.startTime,
            status: { in: ['HELD', 'PENDING_PAYMENT', 'CONFIRMED'] },
          },
          select: { id: true },
        })
        if (existing) throw new ConflictException('Slot is already booked')

        const court = await tx.courts.findUnique({
          where: { id: dto.courtId, is_active: true },
          select: { venue_id: true, slot_duration_mins: true, close_time: true },
        })
        if (!court) throw new NotFoundException('Court not found or inactive')

        const endTime = addMinutesToTime(dto.startTime, court.slot_duration_mins)
        if (endTime > court.close_time) throw new BadRequestException('Slot extends beyond closing time')

        const { price, ruleId } = await calculatePrice(
          tx as Parameters<typeof calculatePrice>[0],
          dto.courtId, dto.date, dto.startTime,
        )

        const booking = await tx.bookings.create({
          data: {
            booking_type: 'online',
            player_id: playerId,
            court_id: dto.courtId,
            venue_id: court.venue_id,
            booking_date: new Date(dto.date),
            start_time: dto.startTime,
            end_time: endTime,
            duration_mins: court.slot_duration_mins,
            total_amount: price,
            base_price: price,
            applied_rule_id: ruleId ?? null,
            status: 'HELD',
            hold_expires_at: new Date(Date.now() + 7 * 60 * 1000),
            created_by: playerId,
          },
        })

        this.redis
          .set(this.redis.keys.slotHold(dto.courtId, dto.date, dto.startTime), playerId, 420)
          .catch((e: unknown) => this.logger.error('Redis hold mirror failed', e))

        return { ...booking, displayAmount: formatPaisa(price) }
      },
      // PgBouncer: fail fast under pool pressure; client should retry
      { isolationLevel: 'Serializable', maxWait: 1500, timeout: 5000 },
    )
  }

  // ── Confirm Payment ────────────────────────────────────────────────────────
  async confirmPayment(bookingId: string, verified: GatewayVerification, _gateway: 'KHALTI' | 'ESEWA') {
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      select: {
        total_amount: true, status: true, player_id: true,
        court_id: true, venue_id: true, booking_date: true, start_time: true,
      },
    })

    if (!booking) throw new NotFoundException('Booking not found')
    if (booking.status !== 'PENDING_PAYMENT') throw new ConflictException(`Booking is ${booking.status}`)
    if (verified.amount !== booking.total_amount) {
      this.logger.error('SECURITY: Payment amount mismatch', {
        bookingId, expected: booking.total_amount, got: verified.amount,
      })
      throw new ConflictException('Payment amount does not match booking')
    }

    const result = await this.prisma.$transaction(
      async (tx: any) => {
        await tx.payments.update({
          where: { booking_id: bookingId },
          data: {
            status: 'SUCCESS',
            gateway_tx_id: verified.txId,
            gateway_response: verified.raw as any,
            completed_at: new Date(),
          },
        })

        const confirmed = await tx.bookings.update({
          where: { id: bookingId, status: 'PENDING_PAYMENT' },
          data: { status: 'CONFIRMED', hold_expires_at: null, updated_at: new Date() },
        })

        const court = await tx.courts.findUnique({
          where: { id: confirmed.court_id },
          select: { capacity: true, min_players: true },
        })

        const matchGroup = await tx.match_groups.create({
          data: {
            booking_id: bookingId,
            venue_id: confirmed.venue_id,
            court_id: confirmed.court_id,
            match_date: confirmed.booking_date,
            start_time: confirmed.start_time,
            end_time: confirmed.end_time,
            admin_id: confirmed.player_id!,
            max_players: court?.capacity ?? 10,
            min_players: court?.min_players ?? 4,
          },
        })

        await tx.match_group_members.create({
          data: {
            match_group_id: matchGroup.id,
            user_id: confirmed.player_id!,
            role: 'admin',
            status: 'confirmed',
          },
        })

        return { confirmed, matchGroup }
      },
      { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 15000 },
    )

    // POST-COMMIT: clean Redis + domain events
    const dateStr = result.confirmed.booking_date.toISOString().split('T')[0]!
    await this.redis.del(this.redis.keys.slotHold(booking.court_id, dateStr, booking.start_time))

    // C-4: Fetch player email/name AFTER commit to populate the confirmation email
    const player = await this.prisma.users.findUnique({
      where: { id: booking.player_id! },
      select: { email: true, name: true },
    })

    await this.notifQueue.add('booking-confirmed', {
      type: 'BOOKING_CONFIRMED', userId: booking.player_id, data: { bookingId },
    })
    await this.emailQueue.add('booking-confirmation', {
      type: 'booking-confirmation',
      to: player?.email ?? '',
      name: player?.name ?? '',
      data: { bookingId },
    })
    await this.analyticsQueue.add('booking-event', { type: 'confirmed', bookingId })

    return result
  }

  // ── Initiate Payment ───────────────────────────────────────────────────────
  async initiatePayment(bookingId: string, gateway: 'KHALTI' | 'ESEWA', playerId: string) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      select: { status: true, player_id: true, total_amount: true, hold_expires_at: true },
    })

    if (!booking) throw new NotFoundException('Booking not found')
    if (booking.player_id !== playerId) throw new ForbiddenException('Not your booking')
    if (booking.status !== 'HELD') throw new ConflictException(`Booking is ${booking.status}`)
    if (booking.hold_expires_at && booking.hold_expires_at < new Date()) {
      throw new ConflictException('Hold has expired — please select the slot again')
    }

    const existingPayment = await this.prisma.payments.findUnique({ where: { booking_id: bookingId } })
    if (existingPayment) return existingPayment

    return this.prisma.$transaction(async (tx: any) => {
      const payment = await tx.payments.create({
        data: {
          booking_id: bookingId, player_id: playerId,
          amount: booking.total_amount, gateway, status: 'INITIATED',
        },
      })
      await tx.bookings.update({
        where: { id: bookingId },
        data: {
          status: 'PENDING_PAYMENT',
          hold_expires_at: new Date(Date.now() + 10 * 60 * 1000),
          updated_at: new Date(),
        },
      })
      return payment
    }, { isolationLevel: 'ReadCommitted' })
  }

  // ── Cancel Booking ─────────────────────────────────────────────────────────
  async cancelBooking(bookingId: string, cancelledBy: string, reason?: string) {
    // H-1: Return full refund details including pct, displayAmount, and policy note
    const txResult = await this.prisma.$transaction(
      async (tx: any) => {
        const rows = await tx.$queryRaw<Array<{
          id: string; status: string; total_amount: number
          venue_id: string; booking_date: Date; start_time: string; player_id: string | null
        }>>`SELECT id, status, total_amount, venue_id, booking_date, start_time, player_id
            FROM bookings WHERE id = ${bookingId}::uuid FOR UPDATE NOWAIT`

        const booking = rows[0]
        if (!booking) throw new NotFoundException('Booking not found')
        if (booking.status !== 'CONFIRMED') throw new BadRequestException(`Cannot cancel ${booking.status} booking`)
        if (booking.player_id !== cancelledBy) throw new ForbiddenException('Not your booking')

        const venue = await tx.venues.findUnique({
          where: { id: booking.venue_id },
          select: { full_refund_hours: true, partial_refund_hours: true, partial_refund_pct: true },
        })

        const fullHours = venue?.full_refund_hours ?? 24
        const partialHours = venue?.partial_refund_hours ?? 6
        const partialPct = venue?.partial_refund_pct ?? 50

        const hours = hoursUntilSlot(booking.booking_date, booking.start_time)
        let refundPct = 0
        let refundNote = 'No refund — cancellation within non-refundable window'

        if (hours > fullHours) {
          refundPct = 100
          refundNote = 'Full refund — cancelled with sufficient notice'
        } else if (hours > partialHours) {
          refundPct = partialPct
          refundNote = `Partial refund (${partialPct}%) — cancellation within ${fullHours}h window`
        }

        const refundAmount = Math.round((booking.total_amount * refundPct) / 100)

        await tx.bookings.update({
          where: { id: bookingId },
          data: {
            status: 'CANCELLED', cancelled_at: new Date(), cancelled_by: cancelledBy,
            cancel_reason: reason ?? null,
            refund_status: refundAmount > 0 ? 'pending' : 'none',
            refund_amount: refundAmount, updated_at: new Date(),
          },
        })

        if (refundAmount > 0) {
          await tx.payments.update({
            where: { booking_id: bookingId },
            data: { refund_initiated_at: new Date() },
          })
        }

        return { refundAmount, refundPct, refundNote }
      },
      { isolationLevel: 'RepeatableRead', maxWait: 3000, timeout: 10000 },
    )

    const { refundAmount, refundPct, refundNote } = txResult

    if (refundAmount > 0) {
      await this.refundQueue.add(
        'process-refund',
        { bookingId, refundAmount },
        { attempts: 5, backoff: { type: 'exponential', delay: 10_000 } },
      )
    }

    // H-1: Return full context so UI can display accurate refund information
    return {
      refundAmount,
      refundPct,
      displayRefund: formatPaisa(refundAmount),
      refundNote,
    }
  }

  // ── Expire Booking ─────────────────────────────────────────────────────────
  async expireBooking(bookingId: string) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      select: { status: true, court_id: true, booking_date: true, start_time: true },
    })
    if (!booking || !['HELD', 'PENDING_PAYMENT'].includes(booking.status)) return

    await this.prisma.bookings.updateMany({
      where: { id: bookingId, status: { in: ['HELD', 'PENDING_PAYMENT'] } },
      data: { status: 'EXPIRED', updated_at: new Date() },
    })

    const dateStr = booking.booking_date.toISOString().split('T')[0]!
    await this.redis.del(this.redis.keys.slotHold(booking.court_id, dateStr, booking.start_time))
  }

  // ── Slot Grid ──────────────────────────────────────────────────────────────
  async getSlotGrid(courtId: string, date: string): Promise<SlotGridItem[]> {
    const court = await this.prisma.courts.findUnique({
      where: { id: courtId, is_active: true },
      select: { open_time: true, close_time: true, slot_duration_mins: true },
    })
    if (!court) throw new NotFoundException('Court not found')

    const slots: Array<{ startTime: string; endTime: string }> = []
    let current = court.open_time
    while (current < court.close_time) {
      const endTime = addMinutesToTime(current, court.slot_duration_mins)
      slots.push({ startTime: current, endTime })
      current = endTime
    }

    const [activeBookings, redisVals] = await Promise.all([
      this.prisma.bookings.findMany({
        where: {
          court_id: courtId, booking_date: new Date(date),
          status: { in: ['HELD', 'PENDING_PAYMENT', 'CONFIRMED'] },
        },
        select: { start_time: true, status: true },
      }),
      this.redis.mget<string>(...slots.map(s => this.redis.keys.slotHold(courtId, date, s.startTime))),
    ])

    const dbMap = new Map(activeBookings.map((b: any) => [b.start_time, b.status]))

    return slots.map((slot, i) => ({
      startTime: slot.startTime,
      endTime: slot.endTime,
      status: (dbMap.get(slot.startTime) ?? (redisVals[i] ? 'HELD' : 'AVAILABLE')) as SlotGridItem['status'],
    }))
  }

  // ── Booking History ────────────────────────────────────────────────────────
  // M-2: cursor is base64-encoded created_at ISO string; filter on created_at not id
  async getBookings(playerId: string, query: BookingQueryDto) {
    const take = Math.min(query.limit ?? 20, 50)
    const page = query.page ?? 1

    let createdAtCursor: Date | undefined
    if (query.cursor) {
      try {
        createdAtCursor = new Date(Buffer.from(query.cursor, 'base64').toString('utf-8'))
        if (isNaN(createdAtCursor.getTime())) createdAtCursor = undefined
      } catch {
        createdAtCursor = undefined
      }
    }

    const bookings = await this.prisma.bookings.findMany({
      where: {
        player_id: playerId,
        ...(query.status ? { status: query.status } : {}),
        ...(createdAtCursor ? { created_at: { lt: createdAtCursor } } : {}),
      },
      orderBy: { created_at: 'desc' },
      take,
      skip: createdAtCursor ? 0 : (page - 1) * take,
      select: {
        id: true, status: true, booking_date: true, start_time: true, end_time: true,
        total_amount: true, hold_expires_at: true, refund_status: true, refund_amount: true,
        created_at: true,
        court: {
          select: {
            id: true, name: true, court_type: true,
            venue: { select: { id: true, name: true, slug: true, cover_image_url: true, address: true } },
          },
        },
        payment: {
          select: { gateway: true, status: true },
        },
      },
    })

    const lastItem = bookings.length === take ? bookings[bookings.length - 1] : undefined
    const nextCursor = lastItem
      ? Buffer.from(lastItem.created_at.toISOString()).toString('base64')
      : null

    return {
      data: bookings.map((b: any) => ({ ...b, displayAmount: formatPaisa(b.total_amount) })),
      meta: { nextCursor, limit: take },
    }
  }

  // ── Booking Detail ─────────────────────────────────────────────────────────
  async getBooking(bookingId: string, playerId: string) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      include: {
        court: {
          include: {
            venue: {
              select: {
                id: true, name: true, slug: true, cover_image_url: true, address: true,
                latitude: true, longitude: true,
                full_refund_hours: true, partial_refund_hours: true, partial_refund_pct: true,
              },
            },
          },
        },
        payment: {
          select: {
            id: true, gateway: true, status: true, amount: true,
            gateway_tx_id: true, initiated_at: true, completed_at: true,
          },
        },
        match_group: {
          select: {
            id: true, is_open: true, max_players: true, min_players: true, invite_token: true,
            members: { select: { user_id: true, role: true, status: true } },
          },
        },
      },
    })

    if (!booking) throw new NotFoundException('Booking not found')
    if (booking.player_id !== playerId) throw new ForbiddenException('Access denied')

    return { ...booking, displayAmount: formatPaisa(booking.total_amount) }
  }
}

import {
  Injectable, Logger, ConflictException, NotFoundException,
  ForbiddenException, BadRequestException,
} from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { PrismaService } from '@futsmandu/database'
import type { Prisma } from '@futsmandu/database'
import { PayoutService } from '@futsmandu/esewa-payout'
import { RedisService } from '@futsmandu/redis'
import { AuditService } from '@futsmandu/audit'
import { calculatePrice, addMinutesToTime, hoursUntilSlot, formatPaisa } from '@futsmandu/utils'
import type { SlotGridItem, GatewayVerification } from '@futsmandu/types'
import type { HoldSlotDto, BookingQueryDto } from './dto/booking.dto.js'

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_ADVANCE_DAYS = 30

// ─── Types ────────────────────────────────────────────────────────────────────

type JoinMode     = 'INVITE_ONLY' | 'OPEN'
type CostSplit    = 'ADMIN_PAYS_ALL' | 'SPLIT_EQUAL'
type BookingType  = 'FULL' | 'PARTIAL'

/**
 * Canonical booking metadata stored in `bookings.booking_meta`.
 * This is the single source of truth — match_groups reads from it, never re-derives.
 */
type BookingMeta = {
  bookingType:        BookingType
  joinMode:           JoinMode
  costSplitMode:      CostSplit
  maxPlayers:         number
  currentPlayerCount: number
  playersNeeded:      number   // always = maxPlayers - currentPlayerCount
  description:        string | null
}

type FriendshipRow = {
  requester_id: string
  recipient_id: string
}

// ─── Derived slot config (computed before transaction, passed in cleanly) ─────

type SlotConfig = {
  bookingType:        BookingType
  joinMode:           JoinMode
  costSplitMode:      CostSplit
  maxPlayers:         number
  currentPlayerCount: number
  playersNeeded:      number
  selectedFriendIds:  string[]
  description:        string | null
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class BookingLifecycleService {
  private readonly logger = new Logger(BookingLifecycleService.name)

  constructor(
    private readonly prisma:      PrismaService,
    private readonly redis:       RedisService,
    private readonly payoutService: PayoutService,
    private readonly audit:       AuditService,
    @InjectQueue('refunds')       private readonly refundQueue:    Queue,
    @InjectQueue('notifications') private readonly notifQueue:     Queue,
    @InjectQueue('analytics')     private readonly analyticsQueue: Queue,
    @InjectQueue('player-emails') private readonly emailQueue:     Queue,
  ) {}

  // ─── holdSlot ──────────────────────────────────────────────────────────────

  async holdSlot(playerId: string, dto: HoldSlotDto) {
    // ── 1. Date guards (outside tx — cheap, throw early) ────────────────────
    const slotDate  = new Date(dto.date)
    const todayUTC  = new Date()
    todayUTC.setUTCHours(0, 0, 0, 0)

    if (isNaN(slotDate.getTime()))  throw new BadRequestException('Invalid date format')
    if (slotDate < todayUTC)        throw new BadRequestException('Cannot book slots in the past')

    const maxDate = new Date(todayUTC)
    maxDate.setUTCDate(maxDate.getUTCDate() + MAX_ADVANCE_DAYS)
    if (slotDate > maxDate) {
      throw new BadRequestException(`Cannot book more than ${MAX_ADVANCE_DAYS} days in advance`)
    }

    // ── 2. Derive & validate slot config (outside tx — pure computation) ────
    const config = this.deriveSlotConfig(dto)

    // ── 3. User eligibility (outside tx — single SELECT, no contention) ─────
    const user = await this.prisma.users.findUnique({
      where:  { id: playerId },
      select: { reliability_score: true, ban_until: true, is_suspended: true, is_active: true, is_verified: true },
    })
    if (!user?.is_active)  throw new NotFoundException('User not found')
    if (!user.is_verified) throw new ForbiddenException('Please verify your email before booking')
    if (user.is_suspended) throw new ForbiddenException('Account suspended — contact support')
    if (user.ban_until && user.ban_until > new Date()) {
      throw new ForbiddenException(`Booking restricted until ${user.ban_until.toISOString()}`)
    }
    if (user.reliability_score < 40) {
      throw new ForbiddenException(`Reliability score too low (${user.reliability_score}/100)`)
    }

    // ── 4. Serializable transaction — lock → validate → create ──────────────
    const lockKey = `${dto.courtId}:${dto.date}:${dto.startTime}`

    const result = await this.prisma.$transaction(async (tx: any) => {
      // Advisory lock — prevents concurrent requests for the same slot
      const [lock] = await tx.$queryRaw<[{ acquired: boolean }]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS acquired`
      if (!lock?.acquired) throw new ConflictException('Slot just taken — choose another time')

      // Fetch court
      const court = await tx.courts.findUnique({
        where:  { id: dto.courtId, is_active: true },
        select: { venue_id: true, slot_duration_mins: true, open_time: true, close_time: true, capacity: true },
      })
      if (!court) throw new NotFoundException('Court not found or inactive')

      const endTime = addMinutesToTime(dto.startTime, court.slot_duration_mins)
      if (endTime > court.close_time) throw new BadRequestException('Slot extends beyond closing time')

      // Capacity check — resolved from config (default to court capacity for FULL bookings)
      const resolvedMaxPlayers = config.maxPlayers || court.capacity
      if (resolvedMaxPlayers > court.capacity) {
        throw new BadRequestException(`maxPlayers cannot exceed court capacity (${court.capacity})`)
      }

      // Range-overlap conflict — bookings AND owner blocks in parallel
      const [existingBooking, blockedSlot] = await Promise.all([
        tx.bookings.findFirst({
          where: {
            court_id:     dto.courtId,
            booking_date: new Date(dto.date),
            status:       { in: ['HELD', 'PENDING_PAYMENT', 'CONFIRMED'] },
            start_time:   { lt: endTime },
            end_time:     { gt: dto.startTime },
          },
          select: { id: true },
        }),
        tx.court_blocks.findFirst({
          where: {
            court_id:     dto.courtId,
            block_date:   new Date(dto.date),
            cancelled_at: null,
            deleted_at:   null,
            start_time:   { lt: endTime },
            end_time:     { gt: dto.startTime },
          },
          select: { id: true },
        }),
      ])
      if (existingBooking) throw new ConflictException('Slot is already booked')
      if (blockedSlot)     throw new ConflictException('Slot is not available for booking')

      // Validate friends (only if any were provided)
      if (config.selectedFriendIds.length > 0) {
        const acceptedFriends = await tx.friendships.findMany({
          where: {
            status: 'accepted',
            OR: [
              { requester_id: playerId, recipient_id: { in: config.selectedFriendIds } },
              { recipient_id: playerId, requester_id: { in: config.selectedFriendIds } },
            ],
          },
          select: { requester_id: true, recipient_id: true },
        }) as FriendshipRow[]

        const acceptedFriendSet = new Set(
          acceptedFriends.map(f => f.requester_id === playerId ? f.recipient_id : f.requester_id),
        )
        const invalidFriend = config.selectedFriendIds.find(id => !acceptedFriendSet.has(id))
        if (invalidFriend) {
          throw new ForbiddenException('Only accepted friends can be auto-added to the booking')
        }
      }

      // Price
      const { price, ruleId } = await calculatePrice(
        tx as Parameters<typeof calculatePrice>[0],
        dto.courtId, dto.date, dto.startTime,
      )

      // ── Build bookingMeta ONCE — this is the canonical record ──────────────
      // match_groups will be seeded from this; never re-derive join/split mode.
      const bookingMeta: BookingMeta = {
        bookingType:        config.bookingType,
        joinMode:           config.joinMode,
        costSplitMode:      config.costSplitMode,
        maxPlayers:         resolvedMaxPlayers,
        currentPlayerCount: config.currentPlayerCount,
        playersNeeded:      config.playersNeeded,
        description:        config.description,
      }

      // Create booking — status CONFIRMED (direct-pay path, payment record created below)
      const booking = await tx.bookings.create({
        data: {
          booking_source:      'PLAYER_SELF',
          booking_name:        dto.bookingName?.trim() || null,
          player_id:           playerId,
          court_id:            dto.courtId,
          venue_id:            court.venue_id,
          booking_date:        new Date(dto.date),
          start_time:          dto.startTime,
          end_time:            endTime,
          duration_mins:       court.slot_duration_mins,
          total_amount:        price,
          base_price:          price,
          applied_rule_id:     ruleId ?? null,
          status:              'CONFIRMED',
          hold_expires_at:     null,
          payment_method:      'ESEWA',
          created_by_user_id:  playerId,
          booking_meta:        bookingMeta as Prisma.InputJsonValue,
        },
      })

      // Payment record (bypassed gateway — direct confirmation path)
      await tx.payments.create({
        data: {
          booking_id:       booking.id,
          player_id:        playerId,
          amount:           price,
          gateway:          'ESEWA',
          payment_method:   'ESEWA',
          status:           'SUCCESS',
          gateway_tx_id:    `player-booking-${booking.id}`,
          gateway_response: {
            source:           'player_booking',
            paymentBypassed:  true,
            reason:           'Temporary direct booking confirmation without external gateway',
          } as Prisma.InputJsonValue,
          initiated_at:  new Date(),
          completed_at:  new Date(),
        },
      })

      // ── Create match_group from bookingMeta — single source of truth ───────
      const matchGroup = await tx.match_groups.create({
        data: {
          booking_id:      booking.id,
          venue_id:        court.venue_id,
          court_id:        dto.courtId,
          match_date:      booking.booking_date,
          start_time:      booking.start_time,
          end_time:        booking.end_time,
          admin_id:        playerId,
          max_players:     resolvedMaxPlayers,
          min_players:     resolvedMaxPlayers,
          is_open:         bookingMeta.joinMode === 'OPEN',
          join_mode:       bookingMeta.joinMode,
          auto_accept:     bookingMeta.bookingType === 'PARTIAL',
          cost_split_mode: bookingMeta.costSplitMode,
          description:     bookingMeta.description,
        },
      })

      // Admin member
      await tx.match_group_members.create({
        data: {
          match_group_id: matchGroup.id,
          user_id:        playerId,
          role:           'admin',
          status:         'confirmed',
        },
      })

      // Auto-add friends (if any)
      if (config.selectedFriendIds.length > 0) {
        await tx.match_group_members.createMany({
          data: config.selectedFriendIds.map(friendId => ({
            match_group_id: matchGroup.id,
            user_id:        friendId,
            role:           'player',
            status:         'confirmed',
            invited_by:     playerId,
          })),
        })
      }

      return {
        ...booking,
        paymentStatus:  'SUCCESS',
        displayAmount:  formatPaisa(price),
        matchGroup,
      }
    }, { isolationLevel: 'Serializable', maxWait: 1500, timeout: 5000 })

    // ── Post-transaction side-effects (non-critical, best-effort) ───────────
    const player = await this.prisma.users.findUnique({
      where:  { id: playerId },
      select: { email: true, name: true },
    })
    await this.enqueueBookingConfirmedJobs(result.id, playerId, player)

    // Log booking
    void this.audit.log({
      actorType: 'USER',
      actorId: playerId,
      action: 'CREATE',
      targetType: 'bookings',
      targetId: result.id,
      metadata: {
        bookingId: result.id,
        courtId: dto.courtId,
        date: dto.date,
        amount: result.total_amount,
        context: 'Direct Booking',
      },
    })

    return result
  }

  // ─── confirmPayment ────────────────────────────────────────────────────────

  async confirmPayment(bookingId: string, verified: GatewayVerification, _gateway: 'KHALTI' | 'ESEWA') {
    const booking = await this.prisma.bookings.findUnique({
      where:  { id: bookingId },
      select: {
        total_amount:  true,
        status:        true,
        player_id:     true,
        court_id:      true,
        venue_id:      true,
        booking_date:  true,
        start_time:    true,
        booking_meta:  true,
        payment:       { select: { id: true } },
        venue:         { select: { owner: { select: { id: true, esewa_id: true } } } },
      },
    })
    if (!booking)                              throw new NotFoundException('Booking not found')
    if (booking.status !== 'PENDING_PAYMENT')  throw new ConflictException(`Booking is ${booking.status}`)
    if (verified.amount !== booking.total_amount) {
      throw new ConflictException('Payment amount does not match booking')
    }

    const result = await this.prisma.$transaction(async (tx: any) => {
      // Update payment
      await tx.payments.update({
        where: { booking_id: bookingId },
        data:  {
          status:           'SUCCESS',
          gateway_tx_id:    verified.txId,
          gateway_response: verified.raw as Prisma.InputJsonValue,
          completed_at:     new Date(),
        },
      })

      // Confirm booking
      const confirmed = await tx.bookings.update({
        where: { id: bookingId, status: 'PENDING_PAYMENT' },
        data:  { status: 'CONFIRMED', hold_expires_at: null, updated_at: new Date() },
      })

      // ── Read match_group config exclusively from booking_meta ─────────────
      // Never re-derive join/split mode here — it was settled at holdSlot time.
      const meta = (booking.booking_meta ?? {}) as BookingMeta

      // Fallback only if meta is missing (legacy/migrated rows)
      const maxPlayers = meta.maxPlayers
        ?? (await tx.courts.findUnique({ where: { id: confirmed.court_id }, select: { capacity: true } }))?.capacity
        ?? 10

      const matchGroup = await tx.match_groups.create({
        data: {
          booking_id:      bookingId,
          venue_id:        confirmed.venue_id,
          court_id:        confirmed.court_id,
          match_date:      confirmed.booking_date,
          start_time:      confirmed.start_time,
          end_time:        confirmed.end_time,
          admin_id:        confirmed.player_id!,
          max_players:     maxPlayers,
          min_players:     maxPlayers,
          is_open:         meta.joinMode === 'OPEN',
          join_mode:       meta.joinMode     ?? 'INVITE_ONLY',
          auto_accept:     meta.bookingType  === 'PARTIAL',
          cost_split_mode: meta.costSplitMode ?? 'ADMIN_PAYS_ALL',
          description:     meta.description  ?? null,
        },
      })

      await tx.match_group_members.create({
        data: { match_group_id: matchGroup.id, user_id: confirmed.player_id!, role: 'admin', status: 'confirmed' },
      })

      return { confirmed, matchGroup }
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 15000 })

    // Clear redis hold
    const dateStr = result.confirmed.booking_date.toISOString().split('T')[0]!
    await this.redis.del(this.redis.keys.slotHold(booking.court_id, dateStr, booking.start_time))

    const player = await this.prisma.users.findUnique({
      where:  { id: booking.player_id! },
      select: { email: true, name: true },
    })
    await this.enqueueBookingConfirmedJobs(bookingId, booking.player_id!, player)
    
    // Log payment confirmation
    void this.audit.log({
      actorType: 'USER',
      actorId: booking.player_id!,
      action: 'PAYMENT',
      targetType: 'bookings',
      targetId: bookingId,
      metadata: {
        bookingId,
        amount: booking.total_amount,
        gateway: _gateway,
        txId: verified.txId,
        context: 'Payment Confirmation',
      },
    })

    return result
  }

  // ─── initiatePayment ───────────────────────────────────────────────────────

  async initiatePayment(bookingId: string, gateway: 'KHALTI' | 'ESEWA', playerId: string) {
    const booking = await this.prisma.bookings.findUnique({
      where:  { id: bookingId },
      select: { status: true, player_id: true, total_amount: true, hold_expires_at: true },
    })
    if (!booking)                          throw new NotFoundException('Booking not found')
    if (booking.player_id !== playerId)    throw new ForbiddenException('Not your booking')
    if (booking.status !== 'HELD')         throw new ConflictException(`Booking is ${booking.status}`)
    if (booking.hold_expires_at && booking.hold_expires_at < new Date()) {
      throw new ConflictException('Hold has expired — please select the slot again')
    }

    // Idempotency — return existing payment record if already initiated
    const existingPayment = await this.prisma.payments.findUnique({ where: { booking_id: bookingId } })
    if (existingPayment) return existingPayment

    return this.prisma.$transaction(async (tx: any) => {
      const payment = await tx.payments.create({
        data: {
          booking_id:     bookingId,
          player_id:      playerId,
          amount:         booking.total_amount,
          gateway,
          payment_method: gateway,
          status:         'INITIATED',
        },
      })
      await tx.bookings.update({
        where: { id: bookingId },
        data:  {
          status:          'PENDING_PAYMENT',
          payment_method:  gateway,
          hold_expires_at: new Date(Date.now() + 10 * 60 * 1000),
          updated_at:      new Date(),
        },
      })
      return payment
    }, { isolationLevel: 'ReadCommitted' })
  }

  // ─── cancelBooking ─────────────────────────────────────────────────────────

  async cancelBooking(bookingId: string, cancelledBy: string, reason?: string) {
    const txResult = await this.prisma.$transaction(async (tx: any) => {
      // Row-level lock — prevents concurrent cancel + expiry race
      const rows = await tx.$queryRaw<
        Array<{ id: string; status: string; total_amount: number; venue_id: string; booking_date: Date; start_time: string; player_id: string | null }>
      >`SELECT id, status, total_amount, venue_id, booking_date, start_time, player_id
        FROM bookings WHERE id = ${bookingId}::uuid FOR UPDATE NOWAIT`

      const booking = rows[0]
      if (!booking)                              throw new NotFoundException('Booking not found')
      if (booking.status !== 'CONFIRMED')        throw new BadRequestException(`Cannot cancel ${booking.status} booking`)
      if (booking.player_id !== cancelledBy)     throw new ForbiddenException('Not your booking')

      const venue = await tx.venues.findUnique({
        where:  { id: booking.venue_id },
        select: { full_refund_hours: true, partial_refund_hours: true, partial_refund_pct: true },
      })

      const fullHours    = venue?.full_refund_hours    ?? 24
      const partialHours = venue?.partial_refund_hours ?? 6
      const partialPct   = venue?.partial_refund_pct   ?? 50
      const hours        = hoursUntilSlot(booking.booking_date, booking.start_time)

      let refundPct  = 0
      let refundNote = 'No refund — cancellation within non-refundable window'
      if (hours > fullHours) {
        refundPct  = 100
        refundNote = 'Full refund — cancelled with sufficient notice'
      } else if (hours > partialHours) {
        refundPct  = partialPct
        refundNote = `Partial refund (${partialPct}%) — cancellation within ${fullHours}h window`
      }

      const refundAmount = Math.round((booking.total_amount * refundPct) / 100)

      await tx.bookings.update({
        where: { id: bookingId },
        data:  {
          status:         'CANCELLED',
          cancelled_at:   new Date(),
          cancelled_by:   cancelledBy,
          cancel_reason:  reason ?? null,
          refund_status:  refundAmount > 0 ? 'pending' : 'none',
          refund_amount:  refundAmount,
          updated_at:     new Date(),
        },
      })

      if (refundAmount > 0) {
        await tx.payments.update({
          where: { booking_id: bookingId },
          data:  { refund_initiated_at: new Date() },
        })
      }

      return { refundAmount, refundPct, refundNote }
    }, { isolationLevel: 'RepeatableRead', maxWait: 3000, timeout: 10000 })

    const { refundAmount, refundPct, refundNote } = txResult
    if (refundAmount > 0) {
      await this.refundQueue.add(
        'process-refund',
        { bookingId, refundAmount },
        { attempts: 5, backoff: { type: 'exponential', delay: 10000 }, removeOnComplete: 100, removeOnFail: 500 },
      )
    }

    // Log cancellation
    void this.audit.log({
      actorType: 'USER',
      actorId: cancelledBy,
      action: 'UPDATE',
      targetType: 'bookings',
      targetId: bookingId,
      metadata: {
        bookingId,
        refundAmount,
        reason,
        context: 'Cancellation',
      },
    })

    return { refundAmount, refundPct, displayRefund: formatPaisa(refundAmount), refundNote }
  }

  // ─── expireBooking ─────────────────────────────────────────────────────────

  async expireBooking(bookingId: string) {
    const booking = await this.prisma.bookings.findUnique({
      where:  { id: bookingId },
      select: { status: true, court_id: true, booking_date: true, start_time: true },
    })
    if (!booking || !['HELD', 'PENDING_PAYMENT'].includes(booking.status)) return

    await this.prisma.bookings.updateMany({
      where: { id: bookingId, status: { in: ['HELD', 'PENDING_PAYMENT'] } },
      data:  { status: 'EXPIRED', updated_at: new Date() },
    })

    const dateStr = booking.booking_date.toISOString().split('T')[0]!
    await this.redis.del(this.redis.keys.slotHold(booking.court_id, dateStr, booking.start_time))
  }

  // ─── getSlotGrid ───────────────────────────────────────────────────────────

  async getSlotGrid(courtId: string, date: string): Promise<SlotGridItem[]> {
    const court = await this.prisma.courts.findUnique({
      where:  { id: courtId, is_active: true },
      select: { open_time: true, close_time: true, slot_duration_mins: true },
    })
    if (!court) throw new NotFoundException('Court not found')

    // Generate all slots for the day
    const slots: Array<{ startTime: string; endTime: string }> = []
    let current = court.open_time
    while (current < court.close_time) {
      const endTime = addMinutesToTime(current, court.slot_duration_mins)
      slots.push({ startTime: current, endTime })
      current = endTime
    }

    type ActiveBookingRow = {
      id: string; start_time: string; end_time: string; status: string
      match_group: { is_open: boolean } | null
    }
    type BlockRangeRow = { start_time: string; end_time: string }

    // Fetch bookings, blocks, and redis holds in parallel
    const [activeBookings, blocks, redisVals] = await Promise.all([
      this.prisma.bookings.findMany({
        where: {
          court_id:     courtId,
          booking_date: new Date(date),
          status:       { in: ['HELD', 'PENDING_PAYMENT', 'CONFIRMED'] },
        },
        select: {
          id: true, start_time: true, end_time: true, status: true,
          match_group: { select: { is_open: true } },
        },
      }) as Promise<ActiveBookingRow[]>,
      this.prisma.court_blocks.findMany({
        where: {
          court_id:     courtId,
          block_date:   new Date(date),
          cancelled_at: null,
          deleted_at:   null,
        },
        select: { start_time: true, end_time: true },
      }) as Promise<BlockRangeRow[]>,
      this.redis.mget<string>(...slots.map(s => this.redis.keys.slotHold(courtId, date, s.startTime))),
    ])

    return slots.map((slot, i): SlotGridItem => {
      const isBlocked = blocks.some(
        b => b.start_time < slot.endTime && b.end_time > slot.startTime,
      )
      // Blocked slots map to CONFIRMED — the public controller remaps non-AVAILABLE/OPEN_TO_JOIN
      // statuses to 'UNAVAILABLE' before sending to unauthenticated callers.
      if (isBlocked) {
        return { startTime: slot.startTime, endTime: slot.endTime, status: 'CONFIRMED' }
      }

      const booking = activeBookings.find(
        b => b.start_time < slot.endTime && b.end_time > slot.startTime,
      )
      if (booking) {
        const status: SlotGridItem['status'] =
          booking.status === 'CONFIRMED' && booking.match_group?.is_open
            ? 'OPEN_TO_JOIN'
            : (booking.status as SlotGridItem['status'])
        return { startTime: slot.startTime, endTime: slot.endTime, status }
      }

      if (redisVals[i]) {
        return { startTime: slot.startTime, endTime: slot.endTime, status: 'HELD' }
      }

      return { startTime: slot.startTime, endTime: slot.endTime, status: 'AVAILABLE' }
    })
  }

  // ─── getBookings ───────────────────────────────────────────────────────────

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
        ...(query.status       ? { status:     query.status }              : {}),
        ...(createdAtCursor    ? { created_at: { lt: createdAtCursor } }   : {}),
      },
      orderBy: { created_at: 'desc' },
      take,
      skip:    createdAtCursor ? 0 : (page - 1) * take,
      select: {
        id: true, status: true, booking_date: true, start_time: true, end_time: true,
        total_amount: true, hold_expires_at: true, refund_status: true, refund_amount: true, created_at: true,
        court: {
          select: {
            id: true, name: true, court_type: true,
            venue: { select: { id: true, name: true, slug: true, cover_image_url: true, address: true } },
          },
        },
        payment: { select: { gateway: true, status: true } },
      },
    })

    const lastItem  = bookings.length === take ? bookings[bookings.length - 1] : undefined
    const nextCursor = lastItem
      ? Buffer.from(lastItem.created_at.toISOString()).toString('base64')
      : null

    return {
      data: bookings.map((b: any) => ({ ...b, displayAmount: formatPaisa(b.total_amount) })),
      meta: { nextCursor, limit: take },
    }
  }

  // ─── getBooking ────────────────────────────────────────────────────────────

  async getBooking(bookingId: string, playerId: string) {
    const booking = await this.prisma.bookings.findUnique({
      where:   { id: bookingId },
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
    if (!booking)                          throw new NotFoundException('Booking not found')
    if (booking.player_id !== playerId)    throw new ForbiddenException('Access denied')
    return { ...booking, displayAmount: formatPaisa(booking.total_amount) }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Derive and validate all slot configuration from the DTO.
   * Runs before the database transaction so errors surface early with no lock held.
   *
   * FULL booking  — caller sends only `maxPlayers` (+ optional name/description/costSplitMode).
   *                 currentPlayerCount is always 1 (admin), playersNeeded is always 0.
   *                 No friendIds, no player count arithmetic. joinMode = INVITE_ONLY.
   *
   * PARTIAL booking — caller must send the full trio:
   *                   currentPlayerCount + playersNeeded + maxPlayers (must sum correctly)
   *                   plus exactly (currentPlayerCount - 1) friendIds for the pre-confirmed players.
   *                   joinMode = OPEN, costSplitMode is always SPLIT_EQUAL.
   */
  private deriveSlotConfig(dto: HoldSlotDto): SlotConfig {
    const bookingType = dto.bookingType ?? 'FULL'

    // ── FULL ──────────────────────────────────────────────────────────────────
    if (bookingType === 'FULL') {
      // For FULL bookings, maxPlayers is optional and defaults to the court's capacity later.
      // If provided, we still respect it (validating it's >= 2 via DTO or logic).
      // friendIds are intentionally ignored for FULL bookings to keep them simple.
      return {
        bookingType:        'FULL',
        joinMode:           'INVITE_ONLY',
        costSplitMode:      dto.costSplitMode ?? 'ADMIN_PAYS_ALL',
        maxPlayers:         dto.maxPlayers ?? 0, // 0 marker means "use court capacity"
        currentPlayerCount: 1,     // admin only
        playersNeeded:      0,     // court is taken entirely
        selectedFriendIds:  [],
        description:        dto.description?.trim() || null,
      }
    }

    // ── PARTIAL ───────────────────────────────────────────────────────────────
    // Validate the three required fields exist before any arithmetic
    if (!dto.currentPlayerCount || dto.currentPlayerCount < 2) {
      throw new BadRequestException('PARTIAL booking requires currentPlayerCount >= 2 (admin + at least one friend)')
    }
    if (!dto.playersNeeded || dto.playersNeeded <= 0) {
      throw new BadRequestException('PARTIAL booking requires playersNeeded > 0')
    }
    if (!dto.maxPlayers) {
      throw new BadRequestException('PARTIAL booking requires maxPlayers')
    }

    // maxPlayers must be the explicit sum — no inference, no silent override
    const expectedMax = dto.currentPlayerCount + dto.playersNeeded
    if (dto.maxPlayers !== expectedMax) {
      throw new BadRequestException(
        `maxPlayers (${dto.maxPlayers}) must equal currentPlayerCount (${dto.currentPlayerCount}) + playersNeeded (${dto.playersNeeded}) = ${expectedMax}`,
      )
    }

    // friendIds must account for every confirmed player except the admin
    const selectedFriendIds  = [...new Set(dto.friendIds ?? [])]
    const expectedFriendCount = dto.currentPlayerCount - 1   // admin (1) + friends = currentPlayerCount
    if (selectedFriendIds.length !== expectedFriendCount) {
      throw new BadRequestException(
        `PARTIAL booking requires exactly ${expectedFriendCount} unique friendId(s) to match currentPlayerCount of ${dto.currentPlayerCount} (admin + friends)`,
      )
    }

    return {
      bookingType:        'PARTIAL',
      joinMode:           'OPEN',
      costSplitMode:      'SPLIT_EQUAL',   // always SPLIT_EQUAL for open/partial matches
      maxPlayers:         dto.maxPlayers,
      currentPlayerCount: dto.currentPlayerCount,
      playersNeeded:      dto.playersNeeded,
      selectedFriendIds,
      description:        dto.description?.trim() || null,
    }
  }

  /**
   * Enqueue the standard post-confirmation jobs (notification, email, analytics).
   * Extracted to avoid duplication between holdSlot and confirmPayment.
   */
  private async enqueueBookingConfirmedJobs(
    bookingId: string,
    userId:    string,
    player:    { email: string; name: string } | null,
  ): Promise<void> {
    const jobOpts = { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 100, removeOnFail: 200 }
    await Promise.all([
      this.notifQueue.add(
        'booking-confirmed',
        { type: 'BOOKING_CONFIRMED', userId, data: { bookingId } },
        jobOpts,
      ),
      this.emailQueue.add(
        'booking-confirmation',
        { type: 'booking-confirmation', to: player?.email ?? '', name: player?.name ?? '', data: { bookingId } },
        jobOpts,
      ),
      this.analyticsQueue.add(
        'booking-event',
        { type: 'confirmed', bookingId },
        { attempts: 2, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 50, removeOnFail: 100 },
      ),
    ])
  }
}
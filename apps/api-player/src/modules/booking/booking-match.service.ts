// FIX SUMMARY (schema alignment):
// 1. slots_available removed from all reads/writes — schema removed this derived column.
//    Capacity is now checked by counting confirmed members inside transactions.
// 2. match_group_id_user_id compound unique key removed from all findUnique calls.
//    Schema replaced @@unique with a partial unique index (WHERE deleted_at IS NULL),
//    which Prisma does not generate a type-safe accessor for. Use findFirst with
//    explicit deleted_at: null filter instead.
// 3. requestJoinMatch upsert replaced with safe create-or-throw — upsert relied on
//    the removed @@unique key.

import { Injectable, ConflictException, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { PrismaService } from '@futsmandu/database'
import type { AddFriendToMatchDto, OpenMatchesQueryDto, RequestJoinDto, RespondJoinRequestDto } from './dto/booking.dto.js'

@Injectable()
export class BookingMatchService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('notifications') private readonly notifQueue: Queue,
    @InjectQueue('player-emails') private readonly emailQueue: Queue,
  ) {}

  async joinBookingSlot(bookingId: string, playerId: string, position?: string) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      select: {
        status: true,
        // FIX: slots_available removed from schema — no longer selected
        match_group: { select: { id: true, is_open: true, max_players: true } },
      },
    })

    if (!booking) throw new NotFoundException('Booking not found')
    if (booking.status !== 'CONFIRMED') throw new ConflictException(`Booking is ${booking.status}`)
    if (!booking.match_group) throw new ConflictException('Booking does not have an open match yet')
    if (!booking.match_group.is_open) throw new ConflictException('Booking is not open for joining')

    // FIX: compute available slots from member count instead of stored column
    const confirmedCount = await this.prisma.match_group_members.count({
      where: { match_group_id: booking.match_group.id, status: 'confirmed', deleted_at: null },
    })
    if (confirmedCount >= booking.match_group.max_players) throw new ConflictException('Booking is full')

    return this.joinMatch(booking.match_group.id, playerId, position)
  }

  async joinMatch(matchId: string, playerId: string, position?: string) {
    const matchPrecheck = await this.prisma.match_groups.findUnique({
      where: { id: matchId },
      select: { is_open: true, skill_filter: true, auto_accept: true, admin_id: true },
    })
    if (!matchPrecheck) throw new NotFoundException('Match not found')
    if (!matchPrecheck.is_open) throw new ForbiddenException('Match is not open for joining')

    if (matchPrecheck.skill_filter) {
      const user = await this.prisma.users.findUnique({
        where: { id: playerId },
        select: { skill_level: true },
      })
      if (user?.skill_level !== matchPrecheck.skill_filter) {
        throw new ForbiddenException(`Match requires ${matchPrecheck.skill_filter} skill`)
      }
    }

    const result = await this.prisma.$transaction(async (tx: any) => {
      const [lockedMatch] = await tx.$queryRaw<Array<{
        id: string; max_players: number; is_open: boolean; auto_accept: boolean; admin_id: string
      }>>`SELECT id, max_players, is_open, auto_accept, admin_id
          FROM match_groups WHERE id = ${matchId}::uuid FOR UPDATE`

      if (!lockedMatch) throw new NotFoundException('Match not found')
      if (!lockedMatch.is_open) throw new ForbiddenException('Match is no longer open')

      // FIX: use findFirst with deleted_at filter — @@unique removed in favour of partial index
      const existing = await tx.match_group_members.findFirst({
        where: { match_group_id: matchId, user_id: playerId, deleted_at: null },
        select: { id: true },
      })
      if (existing) throw new ConflictException('Already in match')

      // FIX: count confirmed members instead of reading slots_available column
      const confirmedCount = await tx.match_group_members.count({
        where: { match_group_id: matchId, status: 'confirmed', deleted_at: null },
      })
      if (confirmedCount >= lockedMatch.max_players) throw new ConflictException('Match is full')

      const status = lockedMatch.auto_accept ? 'confirmed' : 'pending'
      const member = await tx.match_group_members.create({
        data: {
          match_group_id: matchId,
          user_id: playerId,
          status,
          position: (position as 'goalkeeper' | 'defender' | 'midfielder' | 'striker' | null) ?? null,
        },
      })

      // FIX: no slots_available column to update — capacity enforced by member count above

      return { member, autoAccepted: lockedMatch.auto_accept, adminId: lockedMatch.admin_id }
    }, { isolationLevel: 'RepeatableRead', maxWait: 3000, timeout: 10000 })

    if (!result.member.status || result.member.status === 'pending') {
      await this.notifQueue
        .add(
          'match-join-request',
          { type: 'MATCH_INVITE', userId: result.adminId, data: { matchGroupId: matchId } },
          { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 100, removeOnFail: 200 },
        )
        .catch(() => null)
    }

    return result.member
  }

  async requestJoinMatch(playerId: string, dto: RequestJoinDto) {
    const match = await this.prisma.match_groups.findUnique({
      where: { id: dto.matchGroupId },
      // FIX: slots_available removed — fetch max_players for capacity check
      select: { id: true, admin_id: true, is_open: true, join_mode: true, max_players: true },
    })
    if (!match) throw new NotFoundException('Match not found')
    if (!match.is_open || match.join_mode === 'INVITE_ONLY') throw new ForbiddenException('Match is not open for join requests')
    if (match.admin_id === playerId) throw new BadRequestException('Admin is already in this match')

    // FIX: compute capacity from member count
    const confirmedCount = await this.prisma.match_group_members.count({
      where: { match_group_id: dto.matchGroupId, status: 'confirmed', deleted_at: null },
    })
    if (confirmedCount >= match.max_players) throw new ConflictException('Match is full')

    if (match.join_mode === 'FRIENDS_ONLY' && !(await this.isAcceptedFriendship(playerId, match.admin_id))) {
      throw new ForbiddenException('Only friends can request this match')
    }

    // FIX: use findFirst with deleted_at filter — @@unique removed in favour of partial index
    const existingMember = await this.prisma.match_group_members.findFirst({
      where: { match_group_id: dto.matchGroupId, user_id: playerId, deleted_at: null },
      select: { id: true },
    })
    if (existingMember) throw new ConflictException('You already joined this match')

    // FIX: upsert removed — it relied on the now-dropped @@unique key.
    // Check for an existing PENDING request and throw; otherwise create fresh.
    const existingRequest = await this.prisma.match_join_requests.findFirst({
      where: { match_group_id: dto.matchGroupId, user_id: playerId, deleted_at: null },
      select: { id: true, status: true },
    })
    if (existingRequest) {
      if (existingRequest.status === 'PENDING') throw new ConflictException('Join request already sent')
      // If previously rejected/withdrawn, soft-delete the old record and create a new one
      await this.prisma.match_join_requests.update({
        where: { id: existingRequest.id },
        data: { deleted_at: new Date() },
      })
    }

    const request = await this.prisma.match_join_requests.create({
      data: { match_group_id: dto.matchGroupId, user_id: playerId, message: dto.message?.trim() || null, status: 'PENDING' },
    })

    await this.notifQueue.add(
      'match-join-request',
      { type: 'MATCH_JOIN_REQUEST', userId: match.admin_id, data: { matchGroupId: dto.matchGroupId, playerId, requestId: request.id } },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 100, removeOnFail: 200 },
    ).catch(() => null)

    return request
  }

  async respondToJoinRequest(adminId: string, dto: RespondJoinRequestDto) {
    const request = await this.prisma.match_join_requests.findUnique({
      where: { id: dto.requestId },
      include: {
        match_group: { select: { id: true, admin_id: true } },
        user: { select: { id: true, email: true, name: true } },
      },
    })
    if (!request) throw new NotFoundException('Join request not found')
    if (request.match_group.admin_id !== adminId) throw new ForbiddenException('Only match admin can respond')
    if (request.status !== 'PENDING') throw new ConflictException(`Request is already ${request.status}`)

    if (dto.action === 'REJECT') {
      const rejected = await this.prisma.match_join_requests.update({
        where: { id: dto.requestId },
        data: { status: 'REJECTED', responded_at: new Date(), responded_by: adminId },
      })
      await this.notifQueue.add(
        'match-join-rejected',
        { type: 'MATCH_JOIN_REJECTED', userId: request.user_id, data: { matchGroupId: request.match_group_id, requestId: request.id } },
        { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 100, removeOnFail: 200 },
      ).catch(() => null)
      return rejected
    }

    const accepted = await this.prisma.$transaction(async (tx: any) => {
      const [lock] = await tx.$queryRaw<[{ acquired: boolean }]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${request.match_group_id})) AS acquired`
      if (!lock?.acquired) throw new ConflictException('Match just filled up')

      // FIX: slots_available removed — fetch max_players and count members
      const lockedMatch = await tx.match_groups.findUnique({
        where: { id: request.match_group_id },
        select: { booking_id: true, max_players: true, cost_split_mode: true },
      })
      if (!lockedMatch) throw new ConflictException('Match not found')

      const confirmedCount = await tx.match_group_members.count({
        where: { match_group_id: request.match_group_id, status: 'confirmed', deleted_at: null },
      })
      if (confirmedCount >= lockedMatch.max_players) throw new ConflictException('Match just filled up')

      // FIX: use findFirst with deleted_at filter
      const alreadyMember = await tx.match_group_members.findFirst({
        where: { match_group_id: request.match_group_id, user_id: request.user_id, deleted_at: null },
        select: { id: true },
      })
      if (!alreadyMember) {
        const paidAmount = lockedMatch.cost_split_mode === 'SPLIT_EQUAL'
          ? Math.ceil(((await tx.bookings.findUnique({ where: { id: lockedMatch.booking_id }, select: { total_amount: true } }))?.total_amount ?? 0) / lockedMatch.max_players)
          : 0
        await tx.match_group_members.create({
          data: { match_group_id: request.match_group_id, user_id: request.user_id, status: 'confirmed', role: 'player', paid_amount: paidAmount, invited_by: adminId },
        })
      }

      const updatedRequest = await tx.match_join_requests.update({
        where: { id: request.id },
        data: { status: 'ACCEPTED', responded_at: new Date(), responded_by: adminId },
      })

      // FIX: no slots_available column to update — capacity enforced by member count check above
      return updatedRequest
    }, { isolationLevel: 'RepeatableRead', maxWait: 3000, timeout: 10000 })

    await this.emailQueue.add(
      'match-join-accepted-email',
      { type: 'booking-confirmation', to: request.user.email ?? '', name: request.user.name, data: { matchGroupId: request.match_group_id } },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 100, removeOnFail: 200 },
    ).catch(() => null)
    await this.notifQueue.add(
      'match-join-accepted',
      { type: 'MATCH_JOIN_ACCEPTED', userId: request.user_id, data: { matchGroupId: request.match_group_id, requestId: request.id } },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 100, removeOnFail: 200 },
    ).catch(() => null)
    return accepted
  }

  async addFriendToMatch(adminId: string, dto: AddFriendToMatchDto) {
    const match = await this.prisma.match_groups.findUnique({
      where: { id: dto.matchGroupId },
      // FIX: slots_available removed — fetch max_players
      include: { admin: { select: { name: true } }, venue: { select: { name: true } } },
    })
    if (!match) throw new NotFoundException('Match not found')
    if (match.admin_id !== adminId) throw new ForbiddenException('Only match admin can add friends')
    if (!(await this.isAcceptedFriendship(adminId, dto.friendId))) throw new ForbiddenException('Only accepted friends can be added')

    // FIX: compute capacity from member count
    const confirmedCount = await this.prisma.match_group_members.count({
      where: { match_group_id: dto.matchGroupId, status: 'confirmed', deleted_at: null },
    })
    if (confirmedCount >= match.max_players) throw new ConflictException('Match is full')

    const friend = await this.prisma.users.findUnique({ where: { id: dto.friendId }, select: { id: true, name: true, email: true } })
    if (!friend) throw new NotFoundException('Friend not found')

    // FIX: use findFirst with deleted_at filter
    const existingMember = await this.prisma.match_group_members.findFirst({
      where: { match_group_id: dto.matchGroupId, user_id: dto.friendId, deleted_at: null },
      select: { id: true },
    })
    if (existingMember) throw new ConflictException('Friend is already in this match')

    const result = await this.prisma.$transaction(async (tx: any) => {
      const [lock] = await tx.$queryRaw<[{ acquired: boolean }]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${dto.matchGroupId})) AS acquired`
      if (!lock?.acquired) throw new ConflictException('Match just filled up')

      // FIX: slots_available removed — count members inside transaction
      const locked = await tx.match_groups.findUnique({ where: { id: dto.matchGroupId }, select: { max_players: true } })
      if (!locked) throw new NotFoundException('Match not found')
      const innerCount = await tx.match_group_members.count({
        where: { match_group_id: dto.matchGroupId, status: 'confirmed', deleted_at: null },
      })
      if (innerCount >= locked.max_players) throw new ConflictException('Match just filled up')

      const member = await tx.match_group_members.create({
        data: { match_group_id: dto.matchGroupId, user_id: dto.friendId, status: 'confirmed', role: 'player', invited_by: adminId },
      })

      // FIX: no slots_available column to update
      return member
    }, { isolationLevel: 'RepeatableRead', maxWait: 3000, timeout: 10000 })

    await this.emailQueue.add(
      'friend-added-to-match-email',
      {
        type: 'FRIEND_ADDED_TO_MATCH',
        to: friend.email ?? '',
        name: friend.name,
        data: {
          adminName: match.admin.name,
          venueName: match.venue.name,
          date: match.match_date.toISOString().split('T')[0],
          startTime: match.start_time,
          matchGroupId: match.id,
        },
      },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 100, removeOnFail: 200 },
    ).catch(() => null)
    await this.notifQueue.add(
      'friend-added-to-match-notification',
      { type: 'FRIEND_ADDED_TO_MATCH', userId: dto.friendId, data: { matchGroupId: match.id, adminName: match.admin.name, venueName: match.venue.name } },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 100, removeOnFail: 200 },
    ).catch(() => null)
    return result
  }

  async getOpenMatches(query: OpenMatchesQueryDto) {
    const page = query.page ?? 1
    const limit = Math.min(query.limit ?? 20, 50)
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    const fromDate = query.date ? new Date(query.date) : today

    // FIX: slots_available removed — filter by fill_status != FULL instead, then compute
    // available count from _count in the response projection.
    const whereClause = {
      is_open: true,
      fill_status: { not: 'FULL' as const },
      match_date: { gte: fromDate },
      deleted_at: null,
      ...(query.venueId ? { venue_id: query.venueId } : {}),
    }

    const [rows, total] = await Promise.all([
      this.prisma.match_groups.findMany({
        where: whereClause,
        orderBy: [{ match_date: 'asc' }, { start_time: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, match_date: true, start_time: true, end_time: true,
          cost_split_mode: true, description: true, max_players: true,
          fill_status: true,
          venue: { select: { id: true, name: true } },
          court: { select: { id: true, name: true } },
          admin: { select: { id: true, name: true, skill_level: true, elo_rating: true } },
          _count: { select: { members: { where: { status: 'confirmed', deleted_at: null } } } },
        },
      }),
      this.prisma.match_groups.count({ where: whereClause }),
    ])

    return {
      data: rows.map((r: any) => ({
        id: r.id,
        matchDate: r.match_date,
        startTime: r.start_time,
        endTime: r.end_time,
        costSplitMode: r.cost_split_mode,
        description: r.description,
        fillStatus: r.fill_status,
        venue: r.venue,
        court: r.court,
        admin: r.admin,
        memberCount: r._count.members,
        // FIX: derive slotsAvailable from max_players - confirmed member count
        slotsAvailable: Math.max(r.max_players - r._count.members, 0),
        maxPlayers: r.max_players,
      })),
      meta: { page, limit, total },
    }
  }

  async getMatchMembers(matchGroupId: string, requesterId: string) {
    const match = await this.prisma.match_groups.findUnique({
      where: { id: matchGroupId },
      // FIX: use findFirst with deleted_at filter to check membership
      select: { is_open: true, members: { where: { user_id: requesterId, deleted_at: null }, select: { id: true } } },
    })
    if (!match) throw new NotFoundException('Match not found')
    if (!match.is_open && match.members.length === 0) throw new ForbiddenException('You cannot view members of this match')

    const members = await this.prisma.match_group_members.findMany({
      where: { match_group_id: matchGroupId, deleted_at: null },
      orderBy: { joined_at: 'asc' },
      select: {
        user_id: true,
        role: true,
        status: true,
        user: { select: { name: true, profile_image_url: true, skill_level: true, elo_rating: true } },
      },
    })
    return members.map((m: any) => ({
      userId: m.user_id,
      name: m.user.name,
      profileImageUrl: m.user.profile_image_url,
      role: m.role,
      status: m.status,
      skillLevel: m.user.skill_level,
      eloRating: m.user.elo_rating,
    }))
  }

  private async isAcceptedFriendship(userA: string, userB: string) {
    const friendship = await this.prisma.friendships.findFirst({
      where: {
        status: 'accepted',
        OR: [{ requester_id: userA, recipient_id: userB }, { requester_id: userB, recipient_id: userA }],
      },
      select: { id: true },
    })
    return Boolean(friendship)
  }
}
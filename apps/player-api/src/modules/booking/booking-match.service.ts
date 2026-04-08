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
        match_group: { select: { id: true, is_open: true, slots_available: true } },
      },
    })

    if (!booking) throw new NotFoundException('Booking not found')
    if (booking.status !== 'CONFIRMED') throw new ConflictException(`Booking is ${booking.status}`)
    if (!booking.match_group) throw new ConflictException('Booking does not have an open match yet')
    if (!booking.match_group.is_open) throw new ConflictException('Booking is not open for joining')
    if (booking.match_group.slots_available < 1) throw new ConflictException('Booking is full')

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

      const existing = await tx.match_group_members.findUnique({
        where: { match_group_id_user_id: { match_group_id: matchId, user_id: playerId } },
        select: { id: true },
      })
      if (existing) throw new ConflictException('Already in match')

      const confirmedCount = await tx.match_group_members.count({
        where: { match_group_id: matchId, status: 'confirmed' },
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

      const updatedCount = status === 'confirmed' ? confirmedCount + 1 : confirmedCount
      await tx.match_groups.update({
        where: { id: matchId },
        data: { slots_available: Math.max(lockedMatch.max_players - updatedCount, 0) },
      })

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
      select: { id: true, admin_id: true, is_open: true, join_mode: true, slots_available: true },
    })
    if (!match) throw new NotFoundException('Match not found')
    if (!match.is_open || match.join_mode === 'INVITE_ONLY') throw new ForbiddenException('Match is not open for join requests')
    if (match.admin_id === playerId) throw new BadRequestException('Admin is already in this match')
    if (match.slots_available < 1) throw new ConflictException('Match is full')
    if (match.join_mode === 'FRIENDS_ONLY' && !(await this.isAcceptedFriendship(playerId, match.admin_id))) {
      throw new ForbiddenException('Only friends can request this match')
    }

    const existingMember = await this.prisma.match_group_members.findUnique({
      where: { match_group_id_user_id: { match_group_id: dto.matchGroupId, user_id: playerId } },
      select: { id: true },
    })
    if (existingMember) throw new ConflictException('You already joined this match')

    const request = await this.prisma.match_join_requests.upsert({
      where: { match_group_id_user_id: { match_group_id: dto.matchGroupId, user_id: playerId } },
      create: { match_group_id: dto.matchGroupId, user_id: playerId, message: dto.message?.trim() || null, status: 'PENDING' },
      update: { message: dto.message?.trim() || null, status: 'PENDING', responded_at: null, responded_by: null },
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

      const lockedMatch = await tx.match_groups.findUnique({
        where: { id: request.match_group_id },
        select: { booking_id: true, slots_available: true, max_players: true, cost_split_mode: true },
      })
      if (!lockedMatch || lockedMatch.slots_available < 1) throw new ConflictException('Match just filled up')

      const alreadyMember = await tx.match_group_members.findUnique({
        where: { match_group_id_user_id: { match_group_id: request.match_group_id, user_id: request.user_id } },
      })
      if (!alreadyMember) {
        const paidAmount = lockedMatch.cost_split_mode === 'SPLIT_EQUAL'
          ? Math.ceil((await tx.bookings.findUnique({ where: { id: lockedMatch.booking_id }, select: { total_amount: true } })?.total_amount ?? 0) / lockedMatch.max_players)
          : 0
        await tx.match_group_members.create({
          data: { match_group_id: request.match_group_id, user_id: request.user_id, status: 'confirmed', role: 'player', paid_amount: paidAmount, invited_by: adminId },
        })
      }

      const updatedRequest = await tx.match_join_requests.update({
        where: { id: request.id },
        data: { status: 'ACCEPTED', responded_at: new Date(), responded_by: adminId },
      })
      const confirmedCount = await tx.match_group_members.count({ where: { match_group_id: request.match_group_id, status: 'confirmed' } })
      await tx.match_groups.update({ where: { id: request.match_group_id }, data: { slots_available: Math.max(lockedMatch.max_players - confirmedCount, 0) } })
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
      include: { admin: { select: { name: true } }, venue: { select: { name: true } } },
    })
    if (!match) throw new NotFoundException('Match not found')
    if (match.admin_id !== adminId) throw new ForbiddenException('Only match admin can add friends')
    if (!(await this.isAcceptedFriendship(adminId, dto.friendId))) throw new ForbiddenException('Only accepted friends can be added')
    if (match.slots_available < 1) throw new ConflictException('Match is full')

    const friend = await this.prisma.users.findUnique({ where: { id: dto.friendId }, select: { id: true, name: true, email: true } })
    if (!friend) throw new NotFoundException('Friend not found')
    const existingMember = await this.prisma.match_group_members.findUnique({
      where: { match_group_id_user_id: { match_group_id: dto.matchGroupId, user_id: dto.friendId } },
      select: { id: true },
    })
    if (existingMember) throw new ConflictException('Friend is already in this match')

    const result = await this.prisma.$transaction(async (tx: any) => {
      const [lock] = await tx.$queryRaw<[{ acquired: boolean }]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${dto.matchGroupId})) AS acquired`
      if (!lock?.acquired) throw new ConflictException('Match just filled up')
      const locked = await tx.match_groups.findUnique({ where: { id: dto.matchGroupId }, select: { slots_available: true, max_players: true } })
      if (!locked || locked.slots_available < 1) throw new ConflictException('Match just filled up')

      const member = await tx.match_group_members.create({
        data: { match_group_id: dto.matchGroupId, user_id: dto.friendId, status: 'confirmed', role: 'player', invited_by: adminId },
      })
      const confirmedCount = await tx.match_group_members.count({ where: { match_group_id: dto.matchGroupId, status: 'confirmed' } })
      await tx.match_groups.update({ where: { id: dto.matchGroupId }, data: { slots_available: Math.max(locked.max_players - confirmedCount, 0) } })
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
    const [rows, total] = await Promise.all([
      this.prisma.match_groups.findMany({
        where: {
          is_open: true,
          slots_available: { gt: 0 },
          match_date: { gte: fromDate },
          ...(query.venueId ? { venue_id: query.venueId } : {}),
        },
        orderBy: [{ match_date: 'asc' }, { start_time: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, match_date: true, start_time: true, end_time: true,
          cost_split_mode: true, description: true, max_players: true, slots_available: true,
          venue: { select: { id: true, name: true } },
          court: { select: { id: true, name: true } },
          admin: { select: { id: true, name: true, skill_level: true, elo_rating: true } },
          _count: { select: { members: true } },
        },
      }),
      this.prisma.match_groups.count({
        where: {
          is_open: true,
          slots_available: { gt: 0 },
          match_date: { gte: fromDate },
          ...(query.venueId ? { venue_id: query.venueId } : {}),
        },
      }),
    ])

    return {
      data: rows.map((r: any) => ({
        id: r.id,
        matchDate: r.match_date,
        startTime: r.start_time,
        endTime: r.end_time,
        costSplitMode: r.cost_split_mode,
        description: r.description,
        venue: r.venue,
        court: r.court,
        admin: r.admin,
        memberCount: r._count.members,
        slotsAvailable: r.slots_available,
        maxPlayers: r.max_players,
      })),
      meta: { page, limit, total },
    }
  }

  async getMatchMembers(matchGroupId: string, requesterId: string) {
    const match = await this.prisma.match_groups.findUnique({
      where: { id: matchGroupId },
      select: { is_open: true, members: { where: { user_id: requesterId }, select: { id: true } } },
    })
    if (!match) throw new NotFoundException('Match not found')
    if (!match.is_open && match.members.length === 0) throw new ForbiddenException('You cannot view members of this match')

    const members = await this.prisma.match_group_members.findMany({
      where: { match_group_id: matchGroupId },
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

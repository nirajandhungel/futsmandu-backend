// CHANGED: [H-5 joinMatch TOCTOU race condition, L-5 invite token expiry null check]
// NEW ISSUES FOUND:
//   - joinMatch read member count then inserted in separate operations — TOCTOU race (H-5)
//   - generateInviteLink checked token_expires_at in a way that passes when null (L-5)

// apps/player-api/src/modules/match/match.service.ts
// H-5: joinMatch wraps member count check + insert in a single $transaction to eliminate
//      TOCTOU race — without this, concurrent join requests could exceed max_players.
// L-5: Invite token preview only returns valid (non-null, non-expired) tokens.

import {
  Injectable, NotFoundException, ForbiddenException,
  ConflictException, BadRequestException, Logger,
} from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import * as crypto from 'crypto'
import { PrismaService } from '@futsmandu/database'
import { ENV } from '@futsmandu/utils'

@Injectable()
export class MatchService {
  private readonly logger = new Logger(MatchService.name)

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('notifications') private readonly notifQueue: Queue,
    @InjectQueue('player-stats')  private readonly statsQueue: Queue,
  ) {}

  async getMatch(id: string) {
    const m = await this.prisma.match_groups.findUnique({
      where: { id },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true, name: true, profile_image_url: true,
                skill_level: true, elo_rating: true,
              },
            },
          },
        },
        venue: {
          select: {
            id: true, name: true, cover_image_url: true,
            address: true, latitude: true, longitude: true,
          },
        },
        court: { select: { id: true, name: true, court_type: true, surface: true } },
      },
    })
    if (!m) throw new NotFoundException('Match not found')
    return m
  }

  // H-5: Wrap count-check + insert in a transaction to prevent concurrent over-join.
  // Uses SELECT ... FOR UPDATE on match_groups to serialise join attempts.
  async joinMatch(matchId: string, playerId: string, position?: string) {
    // Quick pre-checks outside the transaction (no lock, fast reads)
    const matchPrecheck = await this.prisma.match_groups.findUnique({
      where: { id: matchId },
      select: { is_open: true, skill_filter: true, auto_accept: true, admin_id: true },
    })
    if (!matchPrecheck)          throw new NotFoundException('Match not found')
    if (!matchPrecheck.is_open)  throw new ForbiddenException('Match is not open for joining')

    if (matchPrecheck.skill_filter) {
      const user = await this.prisma.users.findUnique({
        where: { id: playerId },
        select: { skill_level: true },
      })
      if (user?.skill_level !== matchPrecheck.skill_filter) {
        throw new ForbiddenException(`Match requires ${matchPrecheck.skill_filter} skill`)
      }
    }

    return this.prisma.$transaction(async (tx: any) => {
      // Lock the match_groups row to serialise concurrent join attempts
      const [lockedMatch] = await tx.$queryRaw<Array<{
        id: string; max_players: number; is_open: boolean; auto_accept: boolean; admin_id: string
      }>>`SELECT id, max_players, is_open, auto_accept, admin_id
          FROM match_groups WHERE id = ${matchId}::uuid FOR UPDATE`

      if (!lockedMatch) throw new NotFoundException('Match not found')
      if (!lockedMatch.is_open) throw new ForbiddenException('Match is no longer open')

      // Check if already a member
      const existing = await tx.match_group_members.findUnique({
        where: { match_group_id_user_id: { match_group_id: matchId, user_id: playerId } },
        select: { id: true },
      })
      if (existing) throw new ConflictException('Already in match')

      // Count INSIDE the transaction with the row locked
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

      return { member, autoAccepted: lockedMatch.auto_accept, adminId: lockedMatch.admin_id }
    }).then(async (result: any) => {
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
    })
  }

  async approveMember(matchId: string, adminId: string, userId: string) {
    const match = await this.prisma.match_groups.findUnique({
      where: { id: matchId },
      select: { admin_id: true },
    })
    if (!match)                     throw new NotFoundException('Match not found')
    if (match.admin_id !== adminId) throw new ForbiddenException('Only admin can approve')
    return this.prisma.match_group_members.update({
      where: { match_group_id_user_id: { match_group_id: matchId, user_id: userId } },
      data: { status: 'confirmed' },
    })
  }

  async rejectMember(matchId: string, adminId: string, userId: string) {
    const match = await this.prisma.match_groups.findUnique({
      where: { id: matchId },
      select: { admin_id: true },
    })
    if (!match)                     throw new NotFoundException('Match not found')
    if (match.admin_id !== adminId) throw new ForbiddenException('Only admin can reject')
    await this.prisma.match_group_members.delete({
      where: { match_group_id_user_id: { match_group_id: matchId, user_id: userId } },
    })
    return { message: 'Member rejected' }
  }

  async leaveMatch(matchId: string, playerId: string) {
    const match = await this.prisma.match_groups.findUnique({
      where: { id: matchId },
      select: { admin_id: true },
    })
    if (!match) throw new NotFoundException('Match not found')
    if (match.admin_id === playerId) {
      throw new BadRequestException('Admin cannot leave — transfer admin first')
    }
    await this.prisma.match_group_members.delete({
      where: { match_group_id_user_id: { match_group_id: matchId, user_id: playerId } },
    })
    return { message: 'Left match' }
  }

  async setTeams(matchId: string, adminId: string, teams: { A: string[]; B: string[] }) {
    const match = await this.prisma.match_groups.findUnique({
      where: { id: matchId },
      select: { admin_id: true },
    })
    if (!match)                     throw new NotFoundException('Match not found')
    if (match.admin_id !== adminId) throw new ForbiddenException('Only admin can set teams')

    await this.prisma.$transaction([
      ...teams.A.map(uid =>
        this.prisma.match_group_members.update({
          where: { match_group_id_user_id: { match_group_id: matchId, user_id: uid } },
          data: { team_side: 'A' },
        }),
      ),
      ...teams.B.map(uid =>
        this.prisma.match_group_members.update({
          where: { match_group_id_user_id: { match_group_id: matchId, user_id: uid } },
          data: { team_side: 'B' },
        }),
      ),
    ])
    return { message: 'Teams updated' }
  }

  async recordResult(matchId: string, adminId: string, winner: 'A' | 'B' | 'draw') {
    const match = await this.prisma.match_groups.findUnique({
      where: { id: matchId },
      select: { admin_id: true, result_winner: true },
    })
    if (!match)                     throw new NotFoundException('Match not found')
    if (match.admin_id !== adminId) throw new ForbiddenException('Only admin can record result')
    if (match.result_winner)        throw new ConflictException('Result already recorded')

    await this.prisma.match_groups.update({
      where: { id: matchId },
      data: { result_winner: winner },
    })
    await this.statsQueue.add(
      'update-elo',
      { matchGroupId: matchId, winner },
      { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 100, removeOnFail: 200 },
    ).catch(() => null)
    return { message: 'Result recorded', winner }
  }

  async generateInviteLink(matchId: string, adminId: string) {
    const match = await this.prisma.match_groups.findUnique({
      where: { id: matchId },
      select: { admin_id: true, invite_token: true, token_expires_at: true },
    })
    if (!match)                     throw new NotFoundException('Match not found')
    if (match.admin_id !== adminId) throw new ForbiddenException('Only admin can generate invite links')

    // L-5: Both invite_token AND token_expires_at must be non-null and not expired.
    // Previously: if (match.token_expires_at && ...) would pass when token_expires_at is null.
    if (
      match.invite_token !== null &&
      match.invite_token !== undefined &&
      match.token_expires_at !== null &&
      match.token_expires_at !== undefined &&
      match.token_expires_at > new Date()
    ) {
      return {
        token: match.invite_token,
        url: `${ENV['APP_URL']}/join/${match.invite_token}`,
      }
    }

    const token    = crypto.randomBytes(16).toString('hex')
    const expiresAt = new Date(Date.now() + 48 * 3_600_000)
    await this.prisma.match_groups.update({
      where: { id: matchId },
      data: { invite_token: token, token_expires_at: expiresAt },
    })
    return { token, url: `${ENV['APP_URL']}/join/${token}`, expiresAt }
  }

  async getInvitePreview(token: string) {
    const match = await this.prisma.match_groups.findUnique({
      where: { invite_token: token },
      select: {
        id: true, match_date: true, start_time: true, max_players: true,
        skill_filter: true, token_expires_at: true,
        members: { where: { status: 'confirmed' }, select: { user_id: true } },
        venue: { select: { name: true, cover_image_url: true, address: true } },
      },
    })
    if (!match) throw new NotFoundException('Invite link not found')

    // L-5: Explicit null check — passes only when token_expires_at is set and expired
    if (match.token_expires_at !== null && match.token_expires_at < new Date()) {
      throw new NotFoundException('Invite link expired')
    }

    return {
      matchGroupId: match.id,
      venue: match.venue,
      date: match.match_date,
      startTime: match.start_time,
      spotsLeft: match.max_players - match.members.length,
      skillFilter: match.skill_filter,
    }
  }
}

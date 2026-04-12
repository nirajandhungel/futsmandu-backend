// CHANGED: [H-3 DATE-only match_date filter, PERF-1 player context cached 60s]
// NEW ISSUES FOUND:
//   - getTonightFeed passed raw new Date() as match_date — PostgreSQL DATE column requires
//     date-only value (H-3), causing 0 rows returned on every cache miss
//   - getTomorrowFeed same issue with raw Date object
//   - Player context (friends, visited venues, skill) fetched 3× per request across feed types (PERF-1)

// apps/player-api/src/modules/discovery/discovery.service.ts
// Smart Discovery Engine — Play Tonight / Tomorrow / Weekend feeds.
// H-3: match_date queries use DATE-only values (no time component).
// PERF-1: getPlayerContext fetched once and cached in Redis for 60s.

import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import { RedisService } from '@futsmandu/redis'
import { haversineKm } from '@futsmandu/utils'
import type { FeedType, MatchOpportunity, ScoredMatch } from '@futsmandu/types'

interface PlayerContext {
  skill:      string
  friendIds:  string[]
  visitedIds: string[]
}

function score(
  match: MatchOpportunity,
  player: PlayerContext,
  feed: FeedType,
  pLat: number,
  pLng: number,
): number {
  let s = 0
  const slotDt    = new Date(`${match.matchDate.toISOString().split('T')[0]}T${match.startTime}:00+05:45`)
  const hoursLeft = (slotDt.getTime() - Date.now()) / 3_600_000
  const hour      = parseInt(match.startTime.split(':')[0] ?? '0', 10)

  if (feed === 'tonight') {
    s += hoursLeft <= 1 ? 25 : hoursLeft <= 3 ? 20 : hoursLeft <= 6 ? 12 : 5
  } else if (feed === 'tomorrow') {
    s += (hour >= 6 && hour <= 9) ? 25 : (hour >= 17 && hour <= 20) ? 20 : 12
  } else {
    const day = match.matchDate.getDay()
    s += day === 6 ? 20 : 15
    s += (hour >= 14 && hour <= 18) ? 5 : 0
  }

  const km = haversineKm(pLat, pLng, match.venueLat, match.venueLng)
  s += km <= 2 ? 20 : km <= 5 ? 15 : km <= 10 ? 8 : km <= 20 ? 3 : 0

  if (!match.skillFilter || match.skillFilter === player.skill) s += 20
  else if (match.skillFilter === 'beginner' && player.skill === 'intermediate') s += 10

  s += Math.min(match.memberUserIds.filter(id => player.friendIds.includes(id)).length * 10, 20)

  if (player.visitedIds.includes(match.venueId)) s += 5

  s += match.spotsLeft === 1 ? 8 : match.spotsLeft <= 3 ? 4 : 0

  return s
}

// H-3: Convert a Date or string to a PostgreSQL DATE-only string "YYYY-MM-DD",
// then wrap as a new Date at midnight UTC so Prisma sends it as a date scalar.
function toDateOnly(d: Date): Date {
  return new Date(d.toISOString().split('T')[0]!)
}

@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // PERF-1: Fetch and cache player context (friends, visited, skill) once per 60s.
  // This avoids 3× identical queries when all three feed methods run in parallel.
  private async getPlayerContext(playerId: string): Promise<PlayerContext> {
    const cacheKey = this.redis.keys.playerCtx(playerId)
    const cached = await this.redis.get<string>(cacheKey)
    if (cached) {
      try {
        return JSON.parse(cached) as PlayerContext
      } catch {
        // ignore stale/corrupt cache entry
      }
    }

    const [friends, visited, player] = await Promise.all([
      this.prisma.friendships.findMany({
        where: { OR: [{ requester_id: playerId }, { recipient_id: playerId }], status: 'accepted' },
        select: { requester_id: true, recipient_id: true },
      }),
      this.prisma.bookings.findMany({
        where: { player_id: playerId, status: 'COMPLETED' },
        distinct: ['venue_id'],
        select: { venue_id: true },
      }),
      this.prisma.users.findUnique({
        where: { id: playerId },
        select: { skill_level: true },
      }),
    ])

    const ctx: PlayerContext = {
      skill:      player?.skill_level ?? 'beginner',
      friendIds:  friends.map((f: any) => f.requester_id === playerId ? f.recipient_id : f.requester_id),
      visitedIds: visited.map((b: any) => b.venue_id),
    }

    await this.redis.set(cacheKey, JSON.stringify(ctx), 60)
      .catch((e: unknown) => this.logger.error('Failed to cache player context', e))

    return ctx
  }

  async getTonightFeed(playerId: string, lat: number, lng: number) {
    const now    = new Date()
    const cutoff = new Date(); cutoff.setHours(22, 0, 0, 0)
    if (now > cutoff) return { matches: [], hint: 'Check Play Tomorrow for upcoming matches' }

    const minStart = new Date(Date.now() + 30 * 60 * 1000)
    const minTime  = `${String(minStart.getHours()).padStart(2, '0')}:${String(minStart.getMinutes()).padStart(2, '0')}`
    const cacheKey = this.redis.keys.tonightFeed(lat, lng, now.getHours().toString())

    // H-3: Use DATE-only value for match_date filter
    const matchDateOnly = toDateOnly(now)

    return this.getFeed(playerId, lat, lng, cacheKey, 'tonight', () =>
      this.prisma.match_groups.findMany({
        where: { is_open: true, match_date: matchDateOnly, start_time: { gte: minTime } },
        include: {
          members: { where: { status: 'confirmed' }, select: { user_id: true } },
          venue: { select: { id: true, name: true, cover_image_url: true, latitude: true, longitude: true } },
        },
      }), 300)
  }

  async getTomorrowFeed(playerId: string, lat: number, lng: number) {
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1)
    // H-3: DATE-only
    const matchDateOnly = toDateOnly(tomorrow)
    const dateStr       = tomorrow.toISOString().split('T')[0]!
    const cacheKey      = this.redis.keys.tomorrowFeed(lat, lng, dateStr)

    return this.getFeed(playerId, lat, lng, cacheKey, 'tomorrow', () =>
      this.prisma.match_groups.findMany({
        where: { is_open: true, match_date: matchDateOnly },
        include: {
          members: { where: { status: 'confirmed' }, select: { user_id: true } },
          venue: { select: { id: true, name: true, cover_image_url: true, latitude: true, longitude: true } },
        },
      }), 900)
  }

  async getWeekendFeed(playerId: string, lat: number, lng: number) {
    const dates: Date[] = []
    for (let i = 0; i <= 7 && dates.length < 3; i++) {
      const d = new Date(); d.setDate(d.getDate() + i)
      if ([0, 5, 6].includes(d.getDay())) dates.push(d)
    }
    // H-3: Convert each date to DATE-only for Prisma
    const matchDates = dates.map(toDateOnly)
    const cacheKey   = this.redis.keys.weekendFeed(lat, lng, dates[0]?.toISOString().split('T')[0] ?? 'na')

    return this.getFeed(playerId, lat, lng, cacheKey, 'weekend', () =>
      this.prisma.match_groups.findMany({
        where: { is_open: true, match_date: { in: matchDates } },
        include: {
          members: { where: { status: 'confirmed' }, select: { user_id: true } },
          venue: { select: { id: true, name: true, cover_image_url: true, latitude: true, longitude: true } },
        },
      }), 1800)
  }

  async getOpenMatches(params: {
    date?: string; skill?: string; lat?: number; lng?: number; cursor?: string; limit?: number
  }) {
    const limit = Math.min(params.limit ?? 20, 50)
    return this.prisma.match_groups.findMany({
      where: {
        is_open: true,
        ...(params.date  ? { match_date: toDateOnly(new Date(params.date)) } : {}),
        ...(params.skill ? { skill_filter: params.skill as 'beginner' | 'intermediate' | 'advanced' } : {}),
        ...(params.cursor ? { id: { gt: params.cursor } } : {}),
      },
      include: {
        members: { where: { status: 'confirmed' }, select: { user_id: true } },
        venue: { select: { id: true, name: true, cover_image_url: true, address: true } },
      },
      orderBy: [{ match_date: 'asc' }, { start_time: 'asc' }],
      take: limit,
    })
  }

  private async getFeed(
    playerId: string,
    lat: number,
    lng: number,
    cacheKey: string,
    feed: FeedType,
    dbQuery: () => Promise<unknown[]>,
    ttl: number,
  ) {
    const cached = await this.redis.get<string>(cacheKey)
    if (cached) {
      try {
        const all = JSON.parse(cached) as ScoredMatch[]
        return all.filter(m => !m.memberUserIds.includes(playerId)).slice(0, 20)
      } catch {
        // invalid cache — fall through to DB
      }
    }

    type RawMatch = {
      id: string; venue_id: string; match_date: Date; start_time: string
      skill_filter: string | null; max_players: number
      members: { user_id: string }[]
      venue: { id: string; name: string; cover_image_url: string | null; latitude: unknown; longitude: unknown }
    }

    // PERF-1: Use cached player context — avoids 3 parallel DB queries per cold miss
    const [rawMatches, playerCtx] = await Promise.all([
      dbQuery() as Promise<RawMatch[]>,
      this.getPlayerContext(playerId),
    ])

    const scored = rawMatches
      .filter(m => m.max_players - m.members.length > 0)
      .map((m): ScoredMatch => {
        const opp: MatchOpportunity = {
          matchGroupId:   m.id,
          venueId:        m.venue_id,
          venueName:      m.venue.name,
          venueCoverUrl:  m.venue.cover_image_url,
          matchDate:      m.match_date,
          startTime:      m.start_time,
          skillFilter:    m.skill_filter,
          spotsLeft:      m.max_players - m.members.length,
          memberUserIds:  m.members.map(mem => mem.user_id),
          venueLat:       parseFloat(String(m.venue.latitude ?? 0)),
          venueLng:       parseFloat(String(m.venue.longitude ?? 0)),
        }
        return { ...opp, score: score(opp, playerCtx, feed, lat, lng) }
      })
      .sort((a, b) => b.score - a.score)

    await this.redis.set(cacheKey, JSON.stringify(scored.slice(0, 100)), ttl)
      .catch((e: unknown) => this.logger.error('Feed cache write failed', e))

    return scored.filter(m => !m.memberUserIds.includes(playerId)).slice(0, 20)
  }
}

// Analytics service — revenue, occupancy heatmap, no-show rate.
// Results cached in Redis at venue:{venueId}:kpis with 900s TTL.
// All queries scoped to ownerId — zero cross-owner data leakage.
import { Injectable, Logger } from '@nestjs/common'
import { PrismaService, Prisma } from '@futsmandu/database'
import { RedisService } from '@futsmandu/redis'

interface DateRangeQuery {
  from?: string
  to?: string
  courtId?: string
}

interface RevenueQuery extends DateRangeQuery {
  groupBy?: 'day' | 'week' | 'month'
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name)
  private readonly CACHE_TTL = 900 // 15 min

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ── Summary — revenue + booking counts ──────────────────────────────────
  async getSummary(ownerId: string, query: DateRangeQuery) {
    const cacheKey = `analytics:summary:${ownerId}:${query.from ?? ''}:${query.to ?? ''}`
    const cached   = await this.redis.get<unknown>(cacheKey)
    if (cached) return cached

    const venueIds = await this.getOwnerVenueIds(ownerId)
    const dateFilter = this.buildDateFilter(query)

    const [bookings, revenue] = await Promise.all([
      this.prisma.bookings.groupBy({
        by:     ['status'],
        where:  { venue_id: { in: venueIds }, ...dateFilter },
        _count: { id: true },
      }),
      this.prisma.bookings.aggregate({
        where: {
          venue_id: { in: venueIds },
          status:   { in: ['CONFIRMED', 'COMPLETED'] },
          ...dateFilter,
        },
        _sum:   { total_amount: true },
        _count: { id: true },
        _avg:   { total_amount: true },
      }),
    ])

    const summary = {
      totalRevenueRaw: revenue._sum.total_amount ?? 0,
      totalRevenueNPR:   (revenue._sum.total_amount ?? 0).toLocaleString('en-NP', { minimumFractionDigits: 2 }),
      confirmedBookings: revenue._count.id,
      avgBookingValue:   Math.round(revenue._avg.total_amount ?? 0),
      byStatus: Object.fromEntries(
        bookings.map((b: any) => [b.status, b._count.id]),
      ),
    }

    await this.redis.set(cacheKey, summary, this.CACHE_TTL)
    return summary
  }

  // ── Heatmap — occupancy by hour/day ─────────────────────────────────────
  async getHeatmap(ownerId: string, query: DateRangeQuery) {
    const cacheKey = `analytics:heatmap:${ownerId}:${query.from ?? ''}:${query.to ?? ''}:${query.courtId ?? ''}`
    const cached   = await this.redis.get<unknown>(cacheKey)
    if (cached) return cached

    const venueIds = await this.getOwnerVenueIds(ownerId)
    const dateFilter = this.buildDateFilter(query)

    const bookings = await this.prisma.bookings.findMany({
      where: {
        venue_id: { in: venueIds },
        status:   { in: ['CONFIRMED', 'COMPLETED'] },
        ...(query.courtId ? { court_id: query.courtId } : {}),
        ...dateFilter,
      },
      select: { booking_date: true, start_time: true },
    })

    // Build 7×24 heatmap grid (day × hour)
    const grid: number[][] = Array.from({ length: 7 }, () => Array<number>(24).fill(0))
    for (const b of bookings) {
      const day  = new Date(b.booking_date).getDay() // 0-6
      const hour = parseInt(b.start_time.split(':')[0] ?? '0', 10) // 0-23
      const row  = grid[day]
      if (row) row[hour] = (row[hour] ?? 0) + 1
    }

    const heatmap = { grid, totalBookings: bookings.length }
    await this.redis.set(cacheKey, heatmap, this.CACHE_TTL)
    return heatmap
  }

  // ── Revenue grouped by day/week/month ────────────────────────────────────
  async getRevenue(ownerId: string, query: RevenueQuery) {
    const venueIds = await this.getOwnerVenueIds(ownerId)
    if (venueIds.length === 0) return { groupBy: query.groupBy ?? 'day', data: [] }
    
    const groupBy = query.groupBy ?? 'day'
    
    const conditions = [
      Prisma.sql`status IN ('CONFIRMED', 'COMPLETED')`,
      Prisma.sql`venue_id IN (${Prisma.join(venueIds)})`
    ]
    if (query.from) conditions.push(Prisma.sql`booking_date >= ${new Date(query.from)}`)
    if (query.to)   conditions.push(Prisma.sql`booking_date <= ${new Date(query.to)}`)
    
    const where = Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
    
    const grouped = await this.prisma.$queryRaw<Array<{ period: Date; total: bigint }>>`
      SELECT
        DATE_TRUNC(${groupBy}::text, booking_date) AS period,
        SUM(total_amount) AS total
      FROM bookings
      ${where}
      GROUP BY 1
      ORDER BY 1
    `

    return {
      groupBy,
      data: grouped.map((row: { period: Date; total: bigint }) => {
        let periodStr = row.period.toISOString().split('T')[0]!
        if (groupBy === 'month') periodStr = periodStr.substring(0, 7)
        if (groupBy === 'week')  periodStr = periodStr // keep standard date format for week start
        const totalAmount = Number(row.total || 0)
        return {
          period: periodStr,
          totalAmount,
          totalNPR: totalAmount.toLocaleString('en-NP', { minimumFractionDigits: 2 }),
        }
      }),
    }
  }

  // ── No-show rate by court ────────────────────────────────────────────────
  async getNoShowRate(ownerId: string, query: DateRangeQuery) {
    const venueIds   = await this.getOwnerVenueIds(ownerId)
    const dateFilter = this.buildDateFilter(query)

    const courts = await this.prisma.courts.findMany({
      where: { venue: { owner_id: ownerId }, is_active: true },
      select: {
        id: true, name: true,
        venue: { select: { name: true } },
      },
    })

    if (courts.length === 0) return []
    const courtIds = courts.map((c: any) => c.id)

    // PERF: Replace N+1 queries with a single database groupBy
    const stats = await this.prisma.bookings.groupBy({
      by: ['court_id', 'status'],
      where: { court_id: { in: courtIds }, status: { in: ['CONFIRMED', 'COMPLETED', 'NO_SHOW'] }, ...dateFilter },
      _count: { id: true },
    })

    const courtStats = new Map<string, { total: number, noShows: number }>()
    for (const id of courtIds) courtStats.set(id, { total: 0, noShows: 0 })

    for (const stat of stats) {
      const c = courtStats.get(stat.court_id)
      if (c) {
        c.total += stat._count.id
        if (stat.status === 'NO_SHOW') c.noShows += stat._count.id
      }
    }

    return courts.map((court: any) => {
      const { total, noShows } = courtStats.get(court.id)!
      return {
        courtId:   court.id,
        courtName: court.name,
        venueName: court.venue.name,
        total,
        noShows,
        rate: total > 0 ? +((noShows / total) * 100).toFixed(1) : 0,
      }
    })
  }

  // ── Cache invalidation — call after booking confirmed/cancelled ──────────
  async invalidateVenueCache(venueId: string): Promise<void> {
    await this.redis.del(this.redis.keys.venueKpis(venueId))
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  private async getOwnerVenueIds(ownerId: string): Promise<string[]> {
    const cacheKey = `owner:${ownerId}:venue_ids`
    const cached = await this.redis.get<string[]>(cacheKey)
    if (cached) return cached

    const venues = await this.prisma.venues.findMany({
      where: { owner_id: ownerId },
      select: { id: true },
    })
    const ids = venues.map((v: any) => v.id)
    await this.redis.set(cacheKey, ids, 3600) // Cache venue list for 1 hour
    return ids
  }

  private buildDateFilter(query: DateRangeQuery): Record<string, unknown> {
    if (!query.from && !query.to) return {}
    const filter: { gte?: Date; lte?: Date } = {}
    if (query.from) filter.gte = new Date(query.from)
    if (query.to)   filter.lte = new Date(query.to)
    return { booking_date: filter }
  }
}

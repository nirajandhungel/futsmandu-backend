// apps/admin-api/src/modules/analytics/analytics.service.ts
// Platform-wide analytics — no owner scoping.
import { Injectable, Logger } from '@nestjs/common'
import { PrismaService, Prisma } from '@futsmandu/database'
import { RedisService } from '@futsmandu/redis'

interface DateRangeQuery { from?: string; to?: string }
interface RevenueQuery extends DateRangeQuery { groupBy?: 'day' | 'week' | 'month' }

@Injectable()
export class AnalyticsService {
  private readonly logger    = new Logger(AnalyticsService.name)
  private readonly CACHE_TTL = 900

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis:  RedisService,
  ) {}

  async getPlatformSummary(query: DateRangeQuery) {
    const cacheKey = `admin:platform:${query.from ?? ''}:${query.to ?? ''}`
    const cached   = await this.redis.get<unknown>(cacheKey)
    if (cached) return cached

    const dateFilter = this.buildDateFilter(query)

    const [totalUsers, totalOwners, verifiedVenues, bookingStats, revenueStats] = await Promise.all([
      this.prisma.users.count(),
      this.prisma.owners.count(),
      this.prisma.venues.count({ where: { is_verified: true, is_active: true } }),
      this.prisma.bookings.groupBy({ by: ['status'], where: dateFilter, _count: { id: true } }),
      this.prisma.bookings.aggregate({
        where: { status: { in: ['CONFIRMED', 'COMPLETED'] }, ...dateFilter },
        _sum: { total_amount: true }, _count: { id: true },
      }),
    ])

    const result = {
      users: totalUsers, owners: totalOwners, verifiedVenues,
      bookings: {
        byStatus: Object.fromEntries(bookingStats.map((b: any) => [b.status, b._count.id])),
        confirmed: revenueStats._count.id,
        totalRevenueNPR:   (revenueStats._sum.total_amount ?? 0).toLocaleString('en-NP', { minimumFractionDigits: 2 }),
      },
    }
    await this.redis.set(cacheKey, result, this.CACHE_TTL)
    return result
  }

  async getVenueSummary(query: DateRangeQuery) {
    const dateFilter = this.buildDateFilter(query)

    // PERF: Single groupBy replaces N individual aggregate() calls (was up to 50 DB round-trips)
    const [venues, revenueByVenue] = await Promise.all([
      this.prisma.venues.findMany({
        where: { is_active: true },
        select: {
          id: true, name: true, is_verified: true, avg_rating: true,
          owner: { select: { name: true, business_name: true } },
        },
        orderBy: { avg_rating: 'desc' },
        take: 50,
      }),
      this.prisma.bookings.groupBy({
        by: ['venue_id'],
        where: { status: { in: ['CONFIRMED', 'COMPLETED'] }, ...dateFilter },
        _sum:   { total_amount: true },
        _count: { id: true },
      }),
    ])

    // Build a fast O(1) lookup map from the single aggregation result
    const revenueMap = new Map<string, { bookings: number, totalNPR: number }>(
      revenueByVenue.map((r: any) => [
        r.venue_id,
        { bookings: r._count.id, totalNPR: r._sum.total_amount ?? 0 },
      ]),
    )

    const data = venues.map((v: any) => {
      const stats = revenueMap.get(v.id) ?? { bookings: 0, totalNPR: 0 }
      return {
        ...v,
        bookings:   stats.bookings,
        revenueNPR: (stats.totalNPR).toLocaleString('en-NP', { minimumFractionDigits: 2 }),
      }
    })

    return { data }
  }

  async getRevenue(query: RevenueQuery) {
    const groupBy = query.groupBy ?? 'day'
    
    const conditions = [Prisma.sql`status IN ('CONFIRMED', 'COMPLETED')`]
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

  async getNoShowRate(query: DateRangeQuery) {
    const f = this.buildDateFilter(query)
    const [total, noShows] = await Promise.all([
      this.prisma.bookings.count({ where: { status: { in: ['CONFIRMED', 'COMPLETED', 'NO_SHOW'] }, ...f } }),
      this.prisma.bookings.count({ where: { status: 'NO_SHOW', ...f } }),
    ])
    return { total, noShows, rate: total > 0 ? +((noShows / total) * 100).toFixed(1) : 0 }
  }

  async getUserGrowth(query: DateRangeQuery) {
    const conditions = [Prisma.sql`1=1`]
    if (query.from) conditions.push(Prisma.sql`created_at >= ${new Date(query.from)}`)
    if (query.to)   conditions.push(Prisma.sql`created_at <= ${new Date(query.to)}`)
    const where = Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`

    const [players, owners, playersCount, ownersCount] = await Promise.all([
      this.prisma.$queryRaw<Array<{ date: Date; count: bigint }>>`
        SELECT DATE_TRUNC('day', created_at) AS date, COUNT(*) AS count
        FROM users ${where} GROUP BY 1 ORDER BY 1
      `,
      this.prisma.$queryRaw<Array<{ date: Date; count: bigint }>>`
        SELECT DATE_TRUNC('day', created_at) AS date, COUNT(*) AS count
        FROM owners ${where} GROUP BY 1 ORDER BY 1
      `,
      this.prisma.users.count({ where: this.buildDateFilterCreatedAt(query) }),
      this.prisma.owners.count({ where: this.buildDateFilterCreatedAt(query) }),
    ])

    const mapGrowth = (rows: Array<{ date: Date; count: bigint }>) =>
      rows.map(r => ({ date: r.date.toISOString().split('T')[0]!, count: Number(r.count) }))

    return {
      players: mapGrowth(players),
      owners: mapGrowth(owners),
      totals: { players: playersCount, owners: ownersCount }
    }
  }

  async getAuditLogs(query: { limit?: number; skip?: number; actor_type?: any }) {
    const limit = Math.min(query.limit || 20, 100);
    const skip  = query.skip || 0;
    const where = query.actor_type ? { actor_type: query.actor_type } : {};

    const [items, total] = await Promise.all([
      this.prisma.user_activity_log.findMany({
        where,
        take: limit,
        skip,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.user_activity_log.count({ where }),
    ]);

    return { items, total };
  }

  private buildDateFilter(q: DateRangeQuery) {

    if (!q.from && !q.to) return {}
    return { booking_date: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } }
  }

  private buildDateFilterCreatedAt(q: DateRangeQuery) {
    if (!q.from && !q.to) return {}
    return { created_at: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } }
  }
}

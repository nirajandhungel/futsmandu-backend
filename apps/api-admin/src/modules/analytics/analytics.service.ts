// apps/admin-api/src/modules/analytics/analytics.service.ts
// Platform-wide analytics — no owner scoping.
import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
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
        totalRevenuePaisa: revenueStats._sum.total_amount ?? 0,
        totalRevenueNPR:   ((revenueStats._sum.total_amount ?? 0) / 100).toFixed(2),
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
    const revenueMap = new Map<string, { bookings: number, totalPaisa: number }>(
      revenueByVenue.map((r: any) => [
        r.venue_id,
        { bookings: r._count.id, totalPaisa: r._sum.total_amount ?? 0 },
      ]),
    )

    const data = venues.map((v: any) => {
      const stats = revenueMap.get(v.id) ?? { bookings: 0, totalPaisa: 0 }
      return {
        ...v,
        bookings:   stats.bookings,
        revenueNPR: (stats.totalPaisa / 100).toFixed(2),
      }
    })

    return { data }
  }

  async getRevenue(query: RevenueQuery) {
    const bookings = await this.prisma.bookings.findMany({
      where: { status: { in: ['CONFIRMED', 'COMPLETED'] }, ...this.buildDateFilter(query) },
      select: { booking_date: true, total_amount: true },
      orderBy: { booking_date: 'asc' },
    })
    const grouped = new Map<string, number>()
    for (const b of bookings) {
      const key = this.groupKey(new Date(b.booking_date), query.groupBy ?? 'day')
      grouped.set(key, (grouped.get(key) ?? 0) + b.total_amount)
    }
    return {
      groupBy: query.groupBy ?? 'day',
      data: Array.from(grouped.entries()).map(([period, totalPaisa]) => ({
        period, totalPaisa, totalNPR: (totalPaisa / 100).toFixed(2),
      })),
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
    const f = query.from || query.to ? {
      created_at: {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to   ? { lte: new Date(query.to)   } : {}),
      },
    } : {}
    const [players, owners] = await Promise.all([
      this.prisma.users.findMany({ where: f, select: { created_at: true }, orderBy: { created_at: 'asc' } }),
      this.prisma.owners.findMany({ where: f, select: { created_at: true }, orderBy: { created_at: 'asc' } }),
    ])
    const groupDay = (rows: { created_at: Date }[]) => {
      const m = new Map<string, number>()
      for (const r of rows) { const k = r.created_at.toISOString().split('T')[0]!; m.set(k, (m.get(k) ?? 0) + 1) }
      return Array.from(m.entries()).map(([date, count]) => ({ date, count }))
    }
    return { players: groupDay(players), owners: groupDay(owners), totals: { players: players.length, owners: owners.length } }
  }

  async getAuditLogs(query: { limit?: number; cursor?: string }) {
    const limit = Math.min(query.limit || 20, 100)
    return this.prisma.admin_audit_log.findMany({
      take: limit,
      ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
      orderBy: { created_at: 'desc' },
    })
  }

  private buildDateFilter(q: DateRangeQuery) {

    if (!q.from && !q.to) return {}
    return { booking_date: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } }
  }

  private groupKey(date: Date, groupBy: string): string {
    if (groupBy === 'month') return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    if (groupBy === 'week') {
      const d = new Date(date); d.setDate(d.getDate() - d.getDay()); return d.toISOString().split('T')[0]!
    }
    return date.toISOString().split('T')[0]!
  }
}

import {
  Injectable, Logger,
} from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import type { booking_status, booking_source } from '@futsmandu/database'

interface ListBookingsQuery {
  page?: number
  limit?: number
  status?: any // Use any for mapping flexibility
  payment_status?: string
  bookingSource?: booking_source
  venueId?: string
  playerId?: string
  dateFrom?: string
  dateTo?: string
  date?: string
  search?: string
}

interface BookingOverviewQuery {
  dateFrom?: string
  dateTo?: string
  venueId?: string
}

@Injectable()
export class AdminBookingService {
  private readonly logger = new Logger(AdminBookingService.name)

  constructor(private readonly prisma: PrismaService) {}

  async listBookings(query: ListBookingsQuery) {
    const page = Math.max(1, query.page ?? 1)
    const limit = Math.min(100, Math.max(1, query.limit ?? 25))
    const skip = (page - 1) * limit

    const where: Record<string, unknown> = {}

    // 1. Booking Status Mapping
    if (query.status) {
      const status = String(query.status).toUpperCase().replace('-', '_')
      if (status === 'PENDING') {
        where['status'] = { in: ['PENDING_PAYMENT', 'HELD'] }
      } else {
        where['status'] = status
      }
    }

    // 2. Booking Source
    if (query.bookingSource) where['booking_source'] = query.bookingSource
    if (query.venueId)       where['venue_id']       = query.venueId
    if (query.playerId)      where['player_id']      = query.playerId

    // 3. Date Handling
    if (query.date) {
        // Single day filter
        const startOfDay = new Date(query.date)
        startOfDay.setHours(0, 0, 0, 0)
        const endOfDay = new Date(query.date)
        endOfDay.setHours(23, 59, 59, 999)
        
        where['booking_date'] = {
            gte: startOfDay,
            lte: endOfDay
        }
    } else if (query.dateFrom || query.dateTo) {
      where['booking_date'] = {
        ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
        ...(query.dateTo   ? { lte: new Date(query.dateTo)   } : {}),
      }
    }

    // 4. Payment Status Mapping
    if (query.payment_status) {
        const ps = String(query.payment_status).toUpperCase()
        let dbStatus = ps
        if (ps === 'PAID') dbStatus = 'SUCCESS'
        if (ps === 'UNPAID') dbStatus = 'INITIATED'
        
        where['payment'] = {
            status: dbStatus
        }
    }

    if (query.search?.trim()) {
      const search = query.search.trim()
      where['OR'] = [
        { id:     { contains: search, mode: 'insensitive' } },
        { venue:  { name:  { contains: search, mode: 'insensitive' } } },
        { player: { name:  { contains: search, mode: 'insensitive' } } },
        { player: { email: { contains: search, mode: 'insensitive' } } },
        { player: { phone: { contains: search, mode: 'insensitive' } } },
      ]
    }

    const [bookings, total] = await Promise.all([
      this.prisma.bookings.findMany({
        where,
        select: {
          id:             true,
          booking_source: true,   // ← was booking_type (does not exist in schema)
          payment_method: true,
          status:         true,
          booking_date:   true,
          start_time:     true,
          end_time:       true,
          duration_mins:  true,
          total_amount:   true,
          deposit_amount: true,
          remaining_amount: true,
          pay_status:     true,
          refund_status:  true,
          refund_amount:  true,
          created_at:     true,
          player:  { select: { id: true, name: true, email: true, phone: true } },
          venue:   { select: { id: true, name: true, slug: true } },
          court:   { select: { id: true, name: true } },
          payment: { select: { id: true, status: true, gateway: true, amount: true } },
        },
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.bookings.count({ where }),
    ])

    return {
      data: bookings,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }

  async getOverview(query: BookingOverviewQuery) {
    const now = new Date()
    const where: Record<string, unknown> = {}

    if (query.venueId) where['venue_id'] = query.venueId

    if (query.dateFrom || query.dateTo) {
      where['booking_date'] = {
        ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
        ...(query.dateTo   ? { lte: new Date(query.dateTo)   } : {}),
      }
    }

    const [
      total,
      confirmed,
      cancelled,
      pendingPayment,
      upcoming,
      gross,
    ] = await Promise.all([
      this.prisma.bookings.count({ where }),
      this.prisma.bookings.count({ where: { ...where, status: 'CONFIRMED' } }),
      this.prisma.bookings.count({ where: { ...where, status: 'CANCELLED' } }),
      this.prisma.bookings.count({ where: { ...where, status: 'PENDING_PAYMENT' } }),
      this.prisma.bookings.count({
        where: {
          ...where,
          status:       'CONFIRMED',
          booking_date: { gte: now },
        },
      }),
      this.prisma.bookings.aggregate({
        where: { ...where, status: 'CONFIRMED' },
        _sum:  { total_amount: true, deposit_amount: true, remaining_amount: true },
      }),
    ])

    return {
      total,
      confirmed,
      cancelled,
      pendingPayment,
      upcoming,
      grossRevenue: gross._sum.total_amount ?? 0,
      totalDeposits: gross._sum.deposit_amount ?? 0,
      totalRemaining: gross._sum.remaining_amount ?? 0,
    }
  }
}
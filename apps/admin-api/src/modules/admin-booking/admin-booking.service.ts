import {
  Injectable, BadRequestException, NotFoundException, Logger,
} from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import type { booking_status } from '@futsmandu/database'

interface ListBookingsQuery {
  page?: number
  limit?: number
  status?: booking_status
  venueId?: string
  playerId?: string
  dateFrom?: string
  dateTo?: string
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

    if (query.status) where['status'] = query.status
    if (query.venueId) where['venue_id'] = query.venueId
    if (query.playerId) where['player_id'] = query.playerId

    if (query.dateFrom || query.dateTo) {
      where['booking_date'] = {
        ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
        ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
      }
    }

    if (query.search?.trim()) {
      const search = query.search.trim()
      where['OR'] = [
        { id: { contains: search, mode: 'insensitive' } },
        { venue: { name: { contains: search, mode: 'insensitive' } } },
        { player: { name: { contains: search, mode: 'insensitive' } } },
        { player: { email: { contains: search, mode: 'insensitive' } } },
        { player: { phone: { contains: search, mode: 'insensitive' } } },
      ]
    }

    const [bookings, total] = await Promise.all([
      this.prisma.bookings.findMany({
        where,
        select: {
          id: true,
          booking_type: true,
          status: true,
          booking_date: true,
          start_time: true,
          end_time: true,
          total_amount: true,
          refund_status: true,
          created_at: true,
          player: { select: { id: true, name: true, email: true, phone: true } },
          venue: { select: { id: true, name: true, slug: true } },
          court: { select: { id: true, name: true } },
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

  async getBookingDetail(bookingId: string) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        booking_type: true,
        status: true,
        booking_date: true,
        start_time: true,
        end_time: true,
        duration_mins: true,
        total_amount: true,
        base_price: true,
        hold_expires_at: true,
        cancelled_at: true,
        cancel_reason: true,
        refund_status: true,
        refund_amount: true,
        created_by: true,
        created_at: true,
        updated_at: true,
        booking_meta: true,
        player: { select: { id: true, name: true, email: true, phone: true, reliability_score: true } },
        canceller: { select: { id: true, name: true, email: true, phone: true } },
        venue: { select: { id: true, name: true, slug: true, address: true } },
        court: { select: { id: true, name: true, sport_type: true } },
        payment: {
          select: {
            id: true,
            amount: true,
            status: true,
            gateway: true,
            gateway_tx_id: true,
            initiated_at: true,
            completed_at: true,
            refund_initiated_at: true,
            refund_completed_at: true,
          },
        },
        match_group: {
          select: {
            id: true,
            is_open: true,
            join_mode: true,
            cost_split_mode: true,
            max_players: true,
            min_players: true,
            slots_available: true,
            attendance_marked: true,
          },
        },
      },
    })

    if (!booking) throw new NotFoundException('Booking not found')
    return booking
  }

  async cancelBooking(adminId: string, bookingId: string, reason?: string) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        status: true,
        payment: { select: { status: true } },
      },
    })

    if (!booking) throw new NotFoundException('Booking not found')

    if (booking.status === 'CANCELLED') {
      throw new BadRequestException('Booking is already cancelled')
    }
    if (booking.status === 'COMPLETED') {
      throw new BadRequestException('Completed booking cannot be cancelled')
    }
    if (booking.status === 'NO_SHOW') {
      throw new BadRequestException('No-show booking cannot be cancelled')
    }

    const note = reason?.trim() ? reason.trim() : 'Cancelled by admin'

    await this.prisma.bookings.update({
      where: { id: bookingId },
      data: {
        status: 'CANCELLED',
        cancelled_at: new Date(),
        cancel_reason: `[ADMIN:${adminId}] ${note}`,
        refund_status: booking.payment?.status === 'SUCCESS' ? 'PENDING_REVIEW' : null,
        updated_at: new Date(),
      },
    })

    this.logger.log(`Booking ${bookingId} cancelled by admin ${adminId}`)
    return {
      message: 'Booking cancelled',
      bookingId,
      refundStatus: booking.payment?.status === 'SUCCESS' ? 'PENDING_REVIEW' : null,
    }
  }

  async getOverview(query: BookingOverviewQuery) {
    const now = new Date()
    const where: Record<string, unknown> = {}

    if (query.venueId) where['venue_id'] = query.venueId

    if (query.dateFrom || query.dateTo) {
      where['booking_date'] = {
        ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
        ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
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
          status: 'CONFIRMED',
          booking_date: { gte: now },
        },
      }),
      this.prisma.bookings.aggregate({
        where: { ...where, status: 'CONFIRMED' },
        _sum: { total_amount: true },
      }),
    ])

    return {
      total,
      confirmed,
      cancelled,
      pendingPayment,
      upcoming,
      grossRevenue: gross._sum.total_amount ?? 0,
    }
  }
}

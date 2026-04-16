import {
  Injectable, NotFoundException, Logger,
} from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'

import type { PrismaClient } from '@futsmandu/database'

type PrismaTx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

interface ListUsersQuery {
  search?: string
  status?: 'active' | 'banned' | 'suspended'
  page?: number
}

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name)
  private readonly PAGE_SIZE = 25

  constructor(private readonly prisma: PrismaService) {}

  async listUsers(query: ListUsersQuery) {
    const page = Math.max(1, query.page ?? 1)
    const skip = (page - 1) * this.PAGE_SIZE

    const now   = new Date()
    const where: Record<string, unknown> = {}

    if (query.search) {
      where['OR'] = [
        { name:  { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search, mode: 'insensitive' } },
      ]
    }
    if (query.status === 'banned')    where['ban_until']    = { gt: now }
    if (query.status === 'suspended') where['is_suspended'] = true
    if (query.status === 'active') {
      where['is_active']    = true
      where['is_suspended'] = false
      where['OR'] = [{ ban_until: null }, { ban_until: { lte: now } }]
    }

    const [users, total] = await Promise.all([
      this.prisma.users.findMany({
        where,
        select: {
          id: true, name: true, email: true, phone: true,
          reliability_score: true, total_no_shows: true,
          ban_until: true, is_suspended: true, is_active: true,
          matches_played: true, elo_rating: true, created_at: true,
        },
        orderBy: { created_at: 'desc' },
        skip,
        take: this.PAGE_SIZE,
      }),
      this.prisma.users.count({ where }),
    ])

    return {
      data: users,
      meta: { page, limit: this.PAGE_SIZE, total, totalPages: Math.ceil(total / this.PAGE_SIZE) },
    }
  }

  async getUserDetail(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: {
        id: true, name: true, email: true, phone: true,
        reliability_score: true, total_no_shows: true, total_late_cancels: true,
        ban_until: true, is_suspended: true, is_active: true, is_verified: true,
        matches_played: true, matches_won: true, matches_lost: true, matches_draw: true,
        elo_rating: true, skill_level: true, created_at: true,
        penalties: {
          select: {
            id: true, penalty_type: true, reason: true,
            ends_at: true, status: true, created_at: true,
          },
          where:   { status: 'active' },
          orderBy: { created_at: 'desc' },
          take: 10,
        },
        no_show_logs: {
          select: { id: true, booking_id: true, dispute_status: true, created_at: true },
          orderBy: { created_at: 'desc' },
          take: 10,
        },
      },
    })
    if (!user) throw new NotFoundException('User not found')
    return user
  }

  async getUserBookings(userId: string, page = 1) {
    const skip = (page - 1) * 20
    const [bookings, total] = await Promise.all([
      this.prisma.bookings.findMany({
        where:   { player_id: userId },
        select: {
          id:             true,
          status:         true,
          booking_source: true,   // ← was booking_type (field does not exist in schema)
          payment_method: true,
          booking_date:   true,
          start_time:     true,
          end_time:       true,
          total_amount:   true,
          created_at:     true,
          court: { select: { id: true, name: true } },
          venue: { select: { id: true, name: true } },
        },
        orderBy: { created_at: 'desc' },
        skip,
        take: 20,
      }),
      this.prisma.bookings.count({ where: { player_id: userId } }),
    ])
    return { data: bookings, meta: { page, total } }
  }

  async suspendUser(adminId: string, userId: string, reason: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { id: true, name: true },
    })
    if (!user) throw new NotFoundException('User not found')

    await this.prisma.$transaction(async (tx: PrismaTx) => {
      await tx.users.update({
        where: { id: userId },
        data:  { is_suspended: true, updated_at: new Date() },
      })
      await tx.penalty_history.create({
        data: {
          player_id:    userId,
          penalty_type: 'SUSPENDED',
          reason:       reason ?? 'Suspended by admin',
          triggered_by: adminId,
          status:       'active',
        },
      })
    })

    this.logger.log(`User ${userId} suspended by admin ${adminId}`)
    return { message: 'User suspended', userId }
  }

  async reinstateUser(adminId: string, userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { id: true },
    })
    if (!user) throw new NotFoundException('User not found')

    await this.prisma.$transaction(async (tx: PrismaTx) => {
      await tx.users.update({
        where: { id: userId },
        data:  { is_suspended: false, ban_until: null, updated_at: new Date() },
      })
      await tx.penalty_history.updateMany({
        where: { player_id: userId, penalty_type: 'SUSPENDED', status: 'active' },
        data:  { status: 'overridden', admin_note: `Reinstated by admin ${adminId}` },
      })
    })

    this.logger.log(`User ${userId} reinstated by admin ${adminId}`)
    return { message: 'User reinstated', userId }
  }
}
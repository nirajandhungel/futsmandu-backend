import {
  Injectable, NotFoundException, BadRequestException, Logger,
} from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import type { PrismaClient } from '@futsmandu/database'

type PrismaTx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

@Injectable()
export class AdminPenaltiesService {
  private readonly logger = new Logger(AdminPenaltiesService.name)

  constructor(private readonly prisma: PrismaService) {}

  async listPenalties(status: 'active' | 'expired' | 'all' = 'active', page = 1) {
    const PAGE_SIZE = 25
    const skip      = (page - 1) * PAGE_SIZE
    const now       = new Date()

    const where: Record<string, unknown> = {}
    if (status === 'active')  where['status'] = 'active'
    if (status === 'expired') {
      where['OR'] = [
        { status: 'expired' },
        { ends_at: { lt: now }, status: 'active' },
      ]
    }

    const [penalties, total] = await Promise.all([
      this.prisma.penalty_history.findMany({
        where,
        select: {
          id: true, penalty_type: true, reason: true, triggered_by: true,
          ends_at: true, status: true, admin_note: true, created_at: true,
          player: { select: { id: true, name: true, email: true, reliability_score: true } },
        },
        orderBy: { created_at: 'desc' },
        skip,
        take: PAGE_SIZE,
      }),
      this.prisma.penalty_history.count({ where }),
    ])

    return { data: penalties, meta: { page, total } }
  }

  async overridePenalty(adminId: string, penaltyId: string, adminNote: string) {
    const penalty = await this.prisma.penalty_history.findUnique({
      where: { id: penaltyId },
      select: { id: true, player_id: true, penalty_type: true, status: true, ends_at: true },
    })
    if (!penalty) throw new NotFoundException('Penalty not found')
    if (penalty.status !== 'active') {
      throw new BadRequestException('Only active penalties can be overridden')
    }

    await this.prisma.$transaction(async (tx: PrismaTx) => {
      await tx.penalty_history.update({
        where: { id: penaltyId },
        data: {
          status:     'overridden',
          admin_note: adminNote,
        },
      })

      // If it was a ban, clear ban_until on the user
      if (penalty.penalty_type.startsWith('BAN_')) {
        await tx.users.update({
          where: { id: penalty.player_id },
          data:  { ban_until: null, updated_at: new Date() },
        })
      }
    })

    this.logger.log(`Penalty ${penaltyId} overridden by admin ${adminId}`)
    return { message: 'Penalty overridden', penaltyId }
  }

  async listDisputes(page = 1) {
    const PAGE_SIZE = 20
    const skip      = (page - 1) * PAGE_SIZE

    const [disputes, total] = await Promise.all([
      this.prisma.no_show_logs.findMany({
        where: { dispute_status: 'opened' },
        select: {
          id: true, booking_id: true, dispute_status: true,
          dispute_reason: true, created_at: true,
          player: { select: { id: true, name: true, email: true, reliability_score: true } },
          marker: { select: { id: true, name: true } },
        },
        orderBy: { created_at: 'asc' },
        skip,
        take: PAGE_SIZE,
      }),
      this.prisma.no_show_logs.count({ where: { dispute_status: 'opened' } }),
    ])

    return { data: disputes, meta: { page, total } }
  }

  async resolveDispute(adminId: string, disputeId: string, resolution: 'resolved_noshow' | 'resolved_cleared') {
    const log = await this.prisma.no_show_logs.findUnique({
      where: { id: disputeId },
      select: { id: true, player_id: true, dispute_status: true },
    })
    if (!log) throw new NotFoundException('Dispute not found')
    if (log.dispute_status !== 'opened') {
      throw new BadRequestException('Dispute is not in opened state')
    }

    await this.prisma.$transaction(async (tx: PrismaTx) => {
      await tx.no_show_logs.update({
        where: { id: disputeId },
        data: {
          dispute_status: resolution,
          resolved_at:    new Date(),
        },
      })

      // If cleared: restore 20 reliability points (capped at 100)
      if (resolution === 'resolved_cleared') {
        const user = await tx.users.findUnique({
          where: { id: log.player_id },
          select: { reliability_score: true, total_no_shows: true },
        })
        if (user) {
          await tx.users.update({
            where: { id: log.player_id },
            data: {
              reliability_score: Math.min(100, user.reliability_score + 20),
              total_no_shows:    Math.max(0, user.total_no_shows - 1),
              updated_at:        new Date(),
            },
          })
        }
      }
    })

    this.logger.log(`Dispute ${disputeId} resolved as ${resolution} by admin ${adminId}`)
    return { message: 'Dispute resolved', resolution, disputeId }
  }
}

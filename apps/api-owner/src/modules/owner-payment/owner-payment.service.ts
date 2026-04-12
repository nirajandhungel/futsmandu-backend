import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import type { ListOwnerPayoutsQueryDto } from './dto/owner-payment.dto.js'

@Injectable()
export class OwnerPaymentService {
  constructor(private readonly prisma: PrismaService) {}

  async getOwnerPayoutStats(ownerId: string) {
    const [pendingCount, failedCount, successAgg] = await Promise.all([
      this.prisma.owner_payouts.count({
        where: { owner_id: ownerId, status: { in: ['PENDING', 'PROCESSING'] } },
      }),
      this.prisma.owner_payouts.count({
        where: { owner_id: ownerId, status: 'FAILED' },
      }),
      this.prisma.owner_payouts.aggregate({
        where: { owner_id: ownerId, status: 'SUCCESS' },
        _sum: { owner_amount: true },
        _count: { id: true },
      }),
    ])

    return {
      totalReceivedPaisa: successAgg._sum.owner_amount ?? 0,
      totalSuccessfulPayouts: successAgg._count.id,
      pendingCount,
      failedCount,
    }
  }

  async listOwnerPayouts(ownerId: string, query: ListOwnerPayoutsQueryDto) {
    const { status, venueId, cursor, limit = 20 } = query
    return this.prisma.owner_payouts.findMany({
      where: {
        owner_id: ownerId,
        ...(status ? { status } : {}),
        ...(venueId ? { venue_id: venueId } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: Math.min(limit, 50),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        status: true,
        owner_amount: true,
        admin_fee: true,
        total_collected: true,
        admin_fee_pct: true,
        created_at: true,
        completed_at: true,
        esewa_transfer_id: true,
        last_failure_reason: true,
        venue: { select: { id: true, name: true } },
      },
    })
  }

  async getOwnerPayoutDetail(payoutId: string, ownerId: string) {
    const payout = await this.prisma.owner_payouts.findUnique({
      where: { id: payoutId },
      include: {
        venue: { select: { id: true, name: true } },
        booking: {
          select: {
            id: true,
            booking_date: true,
            start_time: true,
            end_time: true,
          },
        },
      },
    })
    if (!payout) throw new NotFoundException('Payout not found')
    if (payout.owner_id !== ownerId) throw new ForbiddenException('Access denied')

    const { esewa_response: _hidden, owner_id: _owner, ...safe } = payout
    return safe
  }
}

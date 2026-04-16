import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import { PayoutService } from '@futsmandu/esewa-payout'
import type { ListPayoutsQueryDto } from './dto/admin-payment.dto.js'

@Injectable()
export class AdminPaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payoutService: PayoutService,
  ) {}

  async getPayoutStats() {
    const [pending, processing, failed, success] = await Promise.all([
      this.prisma.owner_payouts.count({ where: { status: 'PENDING' } }),
      this.prisma.owner_payouts.count({ where: { status: 'PROCESSING' } }),
      this.prisma.owner_payouts.count({ where: { status: 'FAILED' } }),
      this.prisma.owner_payouts.count({ where: { status: 'SUCCESS' } }),
    ])
    return { pending, processing, failed, success }
  }

  async listPayouts(query: ListPayoutsQueryDto) {
    const { status, ownerId, venueId, bookingId, paymentId, cursor, limit = 20 } = query
    return this.prisma.owner_payouts.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(ownerId ? { owner_id: ownerId } : {}),
        ...(venueId ? { venue_id: venueId } : {}),
        ...(bookingId ? { booking_id: bookingId } : {}),
        ...(paymentId ? { payment_id: paymentId } : {}),
      },
      include: {
        owner: { select: { id: true, name: true, email: true, esewa_id: true, esewa_verified: true } },
        venue: { select: { id: true, name: true } },
      },
      orderBy: { created_at: 'desc' },
      take: Math.min(limit, 100),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
  }

  async getPayoutDetail(id: string) {
    const payout = await this.prisma.owner_payouts.findUnique({
      where: { id },
      include: {
        owner: { select: { id: true, name: true, email: true, phone: true } },
        venue: { select: { id: true, name: true } },
        payment: true,
      },
    })
    if (!payout) throw new NotFoundException('Payout not found')
    return payout
  }

  async retryPayout(id: string, adminId: string) {
    await this.payoutService.adminRetryPayout(id, adminId)
    return { message: 'Payout re-queued', payoutId: id }
  }

  async resolveManually(id: string, adminId: string, note: string) {
    const payout = await this.prisma.owner_payouts.findUnique({ where: { id } })
    if (!payout) throw new NotFoundException('Payout not found')
    if (payout.status === 'SUCCESS') throw new BadRequestException('Payout already successful')
    await this.prisma.owner_payouts.update({
      where: { id },
      data: {
        status: 'MANUALLY_RESOLVED',
        resolved_by: adminId,
        resolved_at: new Date(),
        resolution_note: note,
        completed_at: new Date(),
      },
    })
    return { message: 'Payout manually resolved', payoutId: id }
  }

  getAllConfig() {
    return this.prisma.platform_config.findMany({ orderBy: { key: 'asc' } })
  }

  async updateConfig(key: string, value: string, adminId: string) {
    if (key === 'admin_fee_percent') {
      const parsed = Number.parseInt(value, 10)
      if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
        throw new BadRequestException('admin_fee_percent must be 0-100')
      }
    }
    return this.prisma.platform_config.upsert({
      where: { key },
      create: { key, value, updated_by: adminId },
      update: { value, updated_by: adminId },
    })
  }
}
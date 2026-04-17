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

  /**
   * Admin-triggered payout: only allowed once booking start time has arrived.
   * Creates payout record if missing (unique payment_id), then enqueues the payout job.
   */
  async processPayoutForBooking(bookingId: string, adminId: string) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        booking_date: true,
        start_time: true,
        status: true,
        venue_id: true,
        payment: { select: { id: true, status: true, amount: true } },
        venue: { select: { owner: { select: { id: true, esewa_id: true, esewa_verified: true } } } },
      },
    })
    if (!booking) throw new NotFoundException('Booking not found')
    if (!booking.payment?.id) throw new BadRequestException('No payment found for this booking')
    if (booking.payment.status !== 'SUCCESS') throw new BadRequestException('Payment is not successful')
    if (!booking.venue?.owner?.id) throw new BadRequestException('Booking has no owner')
    if (!booking.venue.owner.esewa_verified) throw new BadRequestException('Owner eSewa is not verified')

    // Enforce "only after booking start time"
    const now = new Date()
    const pad2 = (n: number) => String(n).padStart(2, '0')
    const todayStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
    const nowTime = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
    const bookingDateStr = `${booking.booking_date.getFullYear()}-${pad2(booking.booking_date.getMonth() + 1)}-${pad2(booking.booking_date.getDate())}`

    if (bookingDateStr > todayStr || (bookingDateStr === todayStr && booking.start_time > nowTime)) {
      throw new BadRequestException('Payout can be processed only after booking start time')
    }

    // If payout already exists, just enqueue (idempotent)
    const existing = await this.prisma.owner_payouts.findUnique({
      where: { payment_id: booking.payment.id },
      select: { id: true, status: true },
    })
    if (existing) {
      if (existing.status === 'SUCCESS' || existing.status === 'MANUALLY_RESOLVED') {
        throw new BadRequestException('Payout already completed')
      }
      await this.payoutService.enqueuePayoutJob(existing.id)
      return { message: 'Payout queued', payoutId: existing.id }
    }

    const adminFeePct = await this.payoutService.getAdminFeePct()
    const split = this.payoutService.calculateSplit(booking.payment.amount, adminFeePct)

    const created = await this.prisma.owner_payouts.create(
      this.payoutService.buildPayoutCreateOp({
        paymentId: booking.payment.id,
        bookingId: booking.id,
        ownerId: booking.venue.owner.id,
        venueId: booking.venue_id,
        ownerEsewaId: booking.venue.owner.esewa_id ?? '',
        totalPaisa: booking.payment.amount,
        adminFee: split.adminFee,
        ownerAmount: split.ownerAmount,
        adminFeePct,
      }),
    )

    await this.payoutService.enqueuePayoutJob(created.id)
    return { message: 'Payout created and queued', payoutId: created.id }
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
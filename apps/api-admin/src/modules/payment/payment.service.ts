import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { PrismaService, platform_config_type } from '@futsmandu/database'
import { PayoutService } from '@futsmandu/esewa-payout'
import { PlatformConfigType } from './dto/admin-payment.dto.js'
import type { ListPayoutsQueryDto, UpdatePlatformConfigDto } from './dto/admin-payment.dto.js'

@Injectable()
export class AdminPaymentService {
  private readonly logger = new Logger(AdminPaymentService.name)

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

  private async auditLog(adminId: string, action: string, targetId?: string, targetType?: string, metadata?: any) {
    await this.prisma.admin_audit_log.create({
      data: {
        admin_id: adminId,
        action,
        target_id: targetId,
        target_type: targetType,
        metadata: metadata || {},
      },
    }).catch((err: any) => this.logger.error(`Failed to write audit log: ${err.message}`))
  }

  private toPlatformConfigType(type: PlatformConfigType): platform_config_type {
    switch (type) {
      case PlatformConfigType.NUMBER:
        return 'number'
      case PlatformConfigType.BOOLEAN:
        return 'boolean'
      case PlatformConfigType.STRING:
        return 'string'
      default:
        throw new BadRequestException(`Unsupported platform config type: ${String(type)}`)
    }
  }

  /**
   * Admin-triggered payout: only allowed once booking status is COMPLETED.
   * Creates payout record if missing (unique payment_id), then enqueues the payout job.
   */
  async processPayoutForBooking(bookingId: string, adminId: string) {
    const enabled = await this.payoutService.isPayoutEnabled()
    if (!enabled) {
      throw new BadRequestException('Payouts are currently disabled globally')
    }

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
    if (booking.status !== 'COMPLETED') throw new BadRequestException('Payout can only be processed for COMPLETED bookings')
    if (!booking.payment?.id) throw new BadRequestException('No payment found for this booking')
    if (booking.payment.status !== 'SUCCESS') throw new BadRequestException('Payment is not successful')
    if (!booking.venue?.owner?.id) throw new BadRequestException('Booking has no owner')
    if (!booking.venue.owner.esewa_id) throw new BadRequestException('Owner has no eSewa ID configured')
    if (!booking.venue.owner.esewa_verified) throw new BadRequestException('Owner eSewa is not verified')

    // If payout already exists, just enqueue (idempotent)
    const existing = await this.prisma.owner_payouts.findUnique({
      where: { payment_id: booking.payment.id },
      select: { id: true, status: true },
    })

    let payoutId: string

    if (existing) {
      if (existing.status === 'SUCCESS' || existing.status === 'MANUALLY_RESOLVED') {
        throw new BadRequestException('Payout already completed')
      }
      if (existing.status === 'PROCESSING') {
        throw new BadRequestException('Payout is already being processed')
      }
      payoutId = existing.id
      await this.payoutService.enqueuePayoutJob(payoutId)
    } else {
      const adminFeePct = await this.payoutService.getAdminFeePct()
      const split = this.payoutService.calculateSplit(booking.payment.amount, adminFeePct)

      const created = await this.prisma.owner_payouts.create(
        this.payoutService.buildPayoutCreateOp({
          paymentId: booking.payment.id,
          bookingId: booking.id,
          ownerId: booking.venue.owner.id,
          venueId: booking.venue_id,
          ownerEsewaId: booking.venue.owner.esewa_id,
          totalPaisa: booking.payment.amount,
          adminFee: split.adminFee,
          ownerAmount: split.ownerAmount,
          adminFeePct,
        }),
      )
      payoutId = created.id
      await this.payoutService.enqueuePayoutJob(payoutId)
    }

    await this.auditLog(adminId, 'TRIGGER_PAYOUT', payoutId, 'owner_payouts', { bookingId })
    return { message: 'Payout triggered and queued', payoutId }
  }

  async resolveManually(id: string, adminId: string, note: string) {
    const payout = await this.prisma.owner_payouts.findUnique({ where: { id } })
    if (!payout) throw new NotFoundException('Payout not found')
    if (payout.status === 'SUCCESS' || payout.status === 'MANUALLY_RESOLVED') {
      throw new BadRequestException('Payout already completed')
    }

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

    await this.auditLog(adminId, 'MANUAL_RESOLVE_PAYOUT', id, 'owner_payouts', { note })
    return { message: 'Payout manually resolved', payoutId: id }
  }


  getAllConfig() {
    return this.prisma.platform_config.findMany({ orderBy: { key: 'asc' } })
  }

  async updateConfig(key: string, dto: UpdatePlatformConfigDto, adminId: string) {
    const { value, type, description } = dto
    const safeType = this.toPlatformConfigType(type)

    // Type-aware validation
    if (type === 'number') {
      const parsed = Number.parseFloat(value)
      if (Number.isNaN(parsed)) {
        throw new BadRequestException(`${key} must be a valid number`)
      }
      if (key === 'admin_fee_percent' && (parsed < 0 || parsed > 100)) {
        throw new BadRequestException('admin_fee_percent must be between 0 and 100')
      }
    } else if (type === 'boolean') {
      if (value !== 'true' && value !== 'false') {
        throw new BadRequestException(`${key} must be "true" or "false"`)
      }
    }

    const result = await this.prisma.platform_config.upsert({
      where: { key },
      create: {
        key,
        value,
        type: safeType,
        description,
        updated_by: adminId,
      },
      update: {
        value,
        type: safeType,
        description,
        updated_by: adminId,
      },
    })

    this.payoutService.clearCache(key)
    return result
  }
}
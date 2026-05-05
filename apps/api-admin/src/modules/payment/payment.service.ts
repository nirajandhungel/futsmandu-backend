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
    const { status, ownerId, venueId, bookingId, paymentId, page = 1, limit = 20 } = query
    const skip = (page - 1) * limit
    const take = Math.min(limit, 100)

    const where = {
      ...(status ? { status } : {}),
      ...(ownerId ? { owner_id: ownerId } : {}),
      ...(venueId ? { venue_id: venueId } : {}),
      ...(bookingId ? { booking_id: bookingId } : {}),
      ...(paymentId ? { payment_id: paymentId } : {}),
    }

    const [items, total] = await Promise.all([
      this.prisma.owner_payouts.findMany({
        where,
        include: {
          owner: { select: { id: true, name: true, email: true, esewa_id: true, esewa_verified: true } },
          venue: { select: { id: true, name: true } },
        },
        orderBy: { created_at: 'desc' },
        take,
        skip,
      }),
      this.prisma.owner_payouts.count({ where }),
    ])

    return {
      items,
      totalItems: total,
      page,
      totalPages: Math.ceil(total / take),
    }
  }

  async listPayments(query: any) {
    const { status, page = 1, limit = 20 } = query
    const skip = (page - 1) * limit
    const take = Math.min(limit, 100)

    const where = {
      ...(status ? { status } : {}),
    }

    const [items, total] = await Promise.all([
      this.prisma.payments.findMany({
        where,
        include: {
          player: { select: { id: true, name: true, phone: true } },
          booking: { select: { id: true, booking_name: true } },
        },
        orderBy: { initiated_at: 'desc' },
        take,
        skip,
      }),
      this.prisma.payments.count({ where }),
    ])

    return {
      items,
      totalItems: total,
      page,
      totalPages: Math.ceil(total / take),
    }
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
    // Map custom strings to valid action_type enums
    let actionEnum: any = 'UPDATE'
    if (action.includes('PAYMENT')) actionEnum = 'PAYMENT'
    if (action.includes('REFUND')) actionEnum = 'REFUND'
    if (action.includes('CREATE')) actionEnum = 'CREATE'
    if (action.includes('DELETE')) actionEnum = 'DELETE'

    await this.prisma.user_activity_log.create({
      data: {
        actor_id: adminId,
        actor_type: 'ADMIN',
        action: actionEnum,
        target_id: targetId,
        target_type: targetType,
        metadata: {
          ...metadata,
          original_action: action // Preserve original descriptive action
        },
      },
    }).catch((err: any) => this.logger.error(`Failed to write activity log: ${err.message}`))
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
          totalAmount: booking.payment.amount,
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

  /**
   * Record a manual payout to a venue owner.
   * Admin pays the owner manually (e.g., bank transfer, cash) and records it here.
   * Supports partial payouts — admin can pay part of the total and record the rest later.
   */
  async recordManualPayout(data: {
    venueId: string
    amountPaid: number
    note: string
    adminId: string
  }) {
    const { venueId, amountPaid, note, adminId } = data
    if (amountPaid <= 0) throw new BadRequestException('Amount must be positive')

    const venue = await this.prisma.venues.findUnique({
      where: { id: venueId },
      select: { id: true, name: true, owner_id: true, owner: { select: { name: true } } },
    })
    if (!venue) throw new NotFoundException('Venue not found')

    // Find all pending payouts for this venue and mark them as resolved in order
    const pendingPayouts = await this.prisma.owner_payouts.findMany({
      where: { venue_id: venueId, status: { in: ['PENDING', 'FAILED'] } },
      orderBy: { created_at: 'asc' },
    })

    let remainingToPay = amountPaid
    const resolvedIds: string[] = []

    for (const payout of pendingPayouts) {
      if (remainingToPay <= 0) break
      if (remainingToPay >= payout.owner_amount) {
        // Fully cover this payout
        await this.prisma.owner_payouts.update({
          where: { id: payout.id },
          data: {
            status: 'MANUALLY_RESOLVED',
            resolved_by: adminId,
            resolved_at: new Date(),
            resolution_note: `Manual payout: ${note}`,
            completed_at: new Date(),
          },
        })
        remainingToPay -= payout.owner_amount
        resolvedIds.push(payout.id)
      } else {
        // Partial — mark with note but keep PENDING
        await this.prisma.owner_payouts.update({
          where: { id: payout.id },
          data: {
            resolution_note: `Partial payment of NPR ${amountPaid}: ${note}. Remaining: NPR ${payout.owner_amount - remainingToPay}`,
            last_attempted_at: new Date(),
          },
        })
        remainingToPay = 0
      }
    }

    await this.auditLog(adminId, 'MANUAL_PAYOUT', venueId, 'venues', {
      amountPaid,
      venueName: venue.name,
      resolvedPayouts: resolvedIds.length,
      note,
    })

    return {
      message: `NPR ${amountPaid} recorded for ${venue.name}`,
      resolvedPayouts: resolvedIds.length,
      remainingFromPayment: remainingToPay,
    }
  }

  /**
   * Update a booking's pay_status — used when admin confirms remaining amount collected from player.
   */
  async updateBookingPayStatus(bookingId: string, newStatus: string, adminId: string, note?: string) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      select: { id: true, pay_status: true, total_amount: true, deposit_amount: true, remaining_amount: true },
    })
    if (!booking) throw new NotFoundException('Booking not found')

    const validStatuses = ['PENDING', 'DEPOSIT_PAID', 'PAID', 'FAILED', 'REFUNDED']
    if (!validStatuses.includes(newStatus)) {
      throw new BadRequestException(`Invalid pay_status. Must be one of: ${validStatuses.join(', ')}`)
    }

    await this.prisma.bookings.update({
      where: { id: bookingId },
      data: {
        pay_status: newStatus as any,
        remaining_amount: newStatus === 'PAID' ? 0 : booking.remaining_amount,
      },
    })

    await this.auditLog(adminId, 'UPDATE_PAY_STATUS', bookingId, 'bookings', {
      oldStatus: booking.pay_status,
      newStatus,
      note,
    })

    return { message: `Booking pay status updated to ${newStatus}`, bookingId }
  }


  /**
   * Venue-level payout aggregation:
   * Shows all bookings under each venue with total pending payouts.
   */
  async getVenuePayoutSummary() {
    const venues = await this.prisma.venues.findMany({
      where: { is_active: true },
      select: {
        id: true,
        name: true,
        owner: { select: { id: true, name: true, esewa_id: true } },
      },
    })

    const payoutsByVenue = await this.prisma.owner_payouts.groupBy({
      by: ['venue_id', 'status'],
      _sum: { owner_amount: true },
      _count: { id: true },
    })

    const venueMap = new Map<string, { pending: number; paid: number; pendingCount: number; paidCount: number }>()
    for (const p of payoutsByVenue) {
      const entry = venueMap.get(p.venue_id) ?? { pending: 0, paid: 0, pendingCount: 0, paidCount: 0 }
      if (p.status === 'SUCCESS' || p.status === 'MANUALLY_RESOLVED') {
        entry.paid += p._sum.owner_amount ?? 0
        entry.paidCount += p._count.id
      } else {
        entry.pending += p._sum.owner_amount ?? 0
        entry.pendingCount += p._count.id
      }
      venueMap.set(p.venue_id, entry)
    }

    return venues.map((v: { id: string; name: string; owner: { id: string; name: string; esewa_id: string | null } }) => {
      const stats = venueMap.get(v.id) ?? { pending: 0, paid: 0, pendingCount: 0, paidCount: 0 }
      return {
        venueId: v.id,
        venueName: v.name,
        ownerName: v.owner.name,
        ownerEsewaId: v.owner.esewa_id,
        pendingPayoutNPR: stats.pending,
        paidPayoutNPR: stats.paid,
        pendingCount: stats.pendingCount,
        paidCount: stats.paidCount,
        totalPayoutNPR: stats.pending + stats.paid,
      }
    })
  }

  /**
   * Per-booking payment summary with deposit/remaining/payout info.
   */
  async getBookingPaymentSummary(bookingId: string) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        total_amount: true,
        deposit_amount: true,
        remaining_amount: true,
        status: true,
        pay_status: true,
        venue: { select: { id: true, name: true, owner: { select: { id: true, name: true } } } },
        payment: {
          select: {
            id: true, amount: true, status: true, payment_method: true, gateway: true,
            payout: {
              select: {
                id: true, owner_amount: true, admin_fee: true, status: true,
                completed_at: true, resolution_note: true,
              },
            },
          },
        },
      },
    })
    if (!booking) throw new NotFoundException('Booking not found')

    return {
      bookingId: booking.id,
      totalAmount: booking.total_amount,
      depositAmount: booking.deposit_amount,
      remainingAmount: booking.remaining_amount,
      bookingStatus: booking.status,
      payStatus: booking.pay_status,
      venue: booking.venue,
      payment: booking.payment ? {
        paymentId: booking.payment.id,
        amount: booking.payment.amount,
        status: booking.payment.status,
        method: booking.payment.payment_method,
        gateway: booking.payment.gateway,
        payout: booking.payment.payout ? {
          payoutId: booking.payment.payout.id,
          ownerAmount: booking.payment.payout.owner_amount,
          adminFee: booking.payment.payout.admin_fee,
          payoutStatus: booking.payment.payout.status,
          completedAt: booking.payment.payout.completed_at,
          note: booking.payment.payout.resolution_note,
        } : null,
      } : null,
    }
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
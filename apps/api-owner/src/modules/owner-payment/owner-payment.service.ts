// apps/owner-admin-api/src/modules/owner-payment/owner-payment.service.ts
//
// Schema alignment fix applied:
//   - owner_payouts does NOT have a 'booking' Prisma relation declared in schema.
//     The schema defines: payment, owner, venue relations only.
//     booking_id exists as a raw FK column but has no named relation.
//   - To get booking details, navigate via the 'payment' relation which DOES
//     have a 'booking' relation (payments → bookings, 1-to-1 unique).
//   - getOwnerPayoutDetail updated: include.booking removed; include.payment.include.booking added.

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import type { ListOwnerPayoutsQueryDto } from './dto/owner-payment.dto.js'

@Injectable()
export class OwnerPaymentService {
  constructor(private readonly prisma: PrismaService) {}

  async getOwnerPayoutStats(ownerId: string) {
    const [pendingCount, failedCount, successAgg] = await Promise.all([
      this.prisma.owner_payouts.count({
        where: { owner_id: ownerId, status: { in: ['PENDING', 'PROCESSING'] }, deleted_at: null },
      }),
      this.prisma.owner_payouts.count({
        where: { owner_id: ownerId, status: 'FAILED', deleted_at: null },
      }),
      this.prisma.owner_payouts.aggregate({
        where: { owner_id: ownerId, status: 'SUCCESS', deleted_at: null },
        _sum:   { owner_amount: true },
        _count: { id: true },
      }),
    ])

    return {
      totalReceivedPaisa:     successAgg._sum.owner_amount ?? 0,
      totalSuccessfulPayouts: successAgg._count.id,
      pendingCount,
      failedCount,
    }
  }

  async listOwnerPayouts(ownerId: string, query: ListOwnerPayoutsQueryDto) {
    const { status, venueId, cursor, limit = 20 } = query
    return this.prisma.owner_payouts.findMany({
      where: {
        owner_id:   ownerId,
        deleted_at: null,
        ...(status  ? { status }             : {}),
        ...(venueId ? { venue_id: venueId }  : {}),
      },
      orderBy: { created_at: 'desc' },
      take:    Math.min(limit, 50),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id:                  true,
        status:              true,
        owner_amount:        true,
        admin_fee:           true,
        total_collected:     true,
        admin_fee_pct:       true,
        created_at:          true,
        completed_at:        true,
        esewa_transfer_id:   true,
        last_failure_reason: true,
        venue: { select: { id: true, name: true } },
      },
    })
  }

  async getOwnerPayoutDetail(payoutId: string, ownerId: string) {
    // Schema: owner_payouts has relations: payment, owner, venue.
    // There is NO direct 'booking' relation on owner_payouts in the Prisma schema.
    // Booking details are accessed via payment → booking (payments has a booking relation).
    const payout = await this.prisma.owner_payouts.findUnique({
      where: { id: payoutId },
      include: {
        venue: { select: { id: true, name: true } },
        payment: {
          select: {
            id:           true,
            status:       true,
            gateway:      true,
            gateway_tx_id: true,
            completed_at: true,
            // Navigate to booking through payment relation
            booking: {
              select: {
                id:           true,
                booking_date: true,
                start_time:   true,
                end_time:     true,
                booking_source: true,
                payment_method: true,
              },
            },
          },
        },
      },
    })
    if (!payout) throw new NotFoundException('Payout not found')
    if (payout.owner_id !== ownerId) throw new ForbiddenException('Access denied')

    // Strip sensitive fields before returning
    const { esewa_response: _hidden, owner_id: _owner, ...safe } = payout
    return safe
  }
}
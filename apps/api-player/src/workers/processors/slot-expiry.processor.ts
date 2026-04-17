// apps/player-api/src/workers/processors/slot-expiry.processor.ts
// Runs every 2 minutes as fallback — Redis TTL handles 99% of expirations automatically.
// Catches edge cases where Redis failed to auto-expire a hold.

import { Processor, InjectQueue, WorkerHost } from '@nestjs/bullmq'
import { Logger, Inject } from '@nestjs/common'
import { Queue } from 'bullmq'
import { PrismaService } from '@futsmandu/database'
import { RedisService } from '@futsmandu/redis'
import { BookingService } from '../../modules/booking/booking.service.js'

@Processor('slot-expiry')
export class SlotExpiryProcessor extends WorkerHost {
  private readonly logger = new Logger(SlotExpiryProcessor.name)

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(BookingService) private readonly bookingService: BookingService,
    @InjectQueue('notifications') private readonly notifQueue: Queue,
  ) {
    super()
  }

  async process(): Promise<void> {
    const now = new Date()
    const batchSize = 500

    // Batch scan to avoid unbounded reads as bookings grows.
    // Uses a stable ordering so Postgres can use the right index.
    let cursor: { hold_expires_at: Date; id: string } | null = null
    let totalExpired = 0

    type ExpiredBookingRow = {
      id: string
      court_id: string
      booking_date: Date
      start_time: string
      player_id: string | null
      hold_expires_at: Date | null
    }

    while (true) {
      const expired: ExpiredBookingRow[] = (await this.prisma.bookings.findMany({
        where: {
          status: { in: ['HELD', 'PENDING_PAYMENT'] },
          hold_expires_at: { lte: now },
          ...(cursor
            ? {
                OR: [
                  { hold_expires_at: { gt: cursor.hold_expires_at } },
                  { hold_expires_at: cursor.hold_expires_at, id: { gt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ hold_expires_at: 'asc' }, { id: 'asc' }],
        take: batchSize,
        select: {
          id: true,
          court_id: true,
          booking_date: true,
          start_time: true,
          player_id: true,
          hold_expires_at: true,
        },
      })) as any

      if (expired.length === 0) break
      totalExpired += expired.length

      for (const booking of expired) {
        await this.bookingService.expireBooking(booking.id)

        if (booking.player_id) {
          await this.notifQueue
            .add(
              'slot-expired',
              {
                type: 'SLOT_EXPIRING',
                userId: booking.player_id,
                data: { bookingId: booking.id },
              },
              {
                attempts: 2,
                backoff: { type: 'exponential', delay: 3_000 },
                removeOnComplete: 100,
                removeOnFail: 200,
              },
            )
            .catch(() => null)
        }
      }

      const last: ExpiredBookingRow = expired[expired.length - 1]!
      if (!last.hold_expires_at) break
      cursor = { hold_expires_at: last.hold_expires_at, id: last.id }

      if (expired.length < batchSize) break
    }

    if (totalExpired > 0) {
      this.logger.log(`Expired ${totalExpired} stale holds`)
    }
  }
}

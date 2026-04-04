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
    const expired = await this.prisma.bookings.findMany({
      where: { status: { in: ['HELD', 'PENDING_PAYMENT'] }, hold_expires_at: { lte: new Date() } },
      select: { id: true, court_id: true, booking_date: true, start_time: true, player_id: true },
    })

    for (const booking of expired) {
      await this.bookingService.expireBooking(booking.id)

      if (booking.player_id) {
        await this.notifQueue
          .add(
            'slot-expired',
            { type: 'SLOT_EXPIRING', userId: booking.player_id, data: { bookingId: booking.id } },
            { attempts: 2, backoff: { type: 'exponential', delay: 3_000 }, removeOnComplete: 100, removeOnFail: 200 },
          )
          .catch(() => null)
      }
    }

    if (expired.length > 0) {
      this.logger.log(`Expired ${expired.length} stale holds`)
    }
  }
}

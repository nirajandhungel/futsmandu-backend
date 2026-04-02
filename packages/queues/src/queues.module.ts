import { Global, Module } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'
import { RedisModule, RedisService } from '@futsmandu/redis'
import {
  QUEUE_ADMIN_ALERTS,
  QUEUE_ADMIN_EMAILS,
  QUEUE_ANALYTICS,
  QUEUE_IMAGE_PROCESSING,
  QUEUE_NOTIFICATIONS,
  QUEUE_OWNER_EMAILS,
  QUEUE_PAYMENT_RECON,
  QUEUE_PLAYER_EMAILS,
  QUEUE_PLAYER_STATS,
  QUEUE_REFUNDS,
  QUEUE_SMS,
  QUEUE_SLOT_EXPIRY,
} from './queue.constants.js'

@Global()
@Module({
  imports: [
    RedisModule,
    BullModule.forRootAsync({
      imports: [RedisModule],
      inject: [RedisService],
      useFactory: (redis: RedisService) => ({
        // Reuse the already-created ioredis instance so BullMQ doesn't create sockets.
        connection: redis.bullClient,
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_NOTIFICATIONS },
      { name: QUEUE_PAYMENT_RECON },
      { name: QUEUE_REFUNDS },
      { name: QUEUE_PLAYER_STATS },
      { name: QUEUE_PLAYER_EMAILS },
      { name: QUEUE_SMS },
      { name: QUEUE_SLOT_EXPIRY },
      { name: QUEUE_ANALYTICS },
      { name: QUEUE_IMAGE_PROCESSING },
      { name: QUEUE_OWNER_EMAILS },
      { name: QUEUE_ADMIN_EMAILS },
      { name: QUEUE_ADMIN_ALERTS },
    ),
  ],
  exports: [BullModule],
})
export class QueuesModule {}


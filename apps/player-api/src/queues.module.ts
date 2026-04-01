// CHANGED: [M-4 — new file, consolidates all queue registrations to prevent duplicate processors]
// NEW ISSUES FOUND: none (new file)

// apps/player-api/src/queues.module.ts
// M-4: Single authoritative BullMQ queue registration module.
// All feature modules import QueuesModule instead of registering queues themselves.
// Prevents duplicate processor registrations that could cause jobs to run twice.

import { Module } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'
import { RedisModule, RedisService } from '@futsmandu/redis'

@Module({
  imports: [
    RedisModule,
    BullModule.forRootAsync({
      imports: [RedisModule],
      inject: [RedisService],
      useFactory: (redis: RedisService) => ({
        // IMPORTANT: pass the already-created ioredis instance so BullMQ reuses sockets.
        // `bullmq` ships with its own `ioredis` types, so we cast to avoid TS
        // incompatibilities while still reusing the real client instance at runtime.
        connection: redis.bullClient as any,
      }),
    }),
    BullModule.registerQueue(
      { name: 'notifications' },
      { name: 'payment-recon' },
      { name: 'refunds' },
      { name: 'player-stats' },
      { name: 'player-emails' },
      { name: 'sms' },
      { name: 'slot-expiry' },
      { name: 'analytics' },
      { name: 'image-processing' },
    ),
  ],
  exports: [BullModule],
})
export class QueuesModule {}

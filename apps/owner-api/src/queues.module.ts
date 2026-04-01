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
        // Reuse the already-created ioredis instance (prevents BullMQ from creating sockets)
        connection: redis.bullClient as any,
      }),
    }),
    BullModule.registerQueue(
      { name: 'notifications' },
      { name: 'owner-emails' },
      { name: 'sms' },
      { name: 'image-processing' },
    ),
  ],
  exports: [BullModule],
})
export class QueuesModule {}


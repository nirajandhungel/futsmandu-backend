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
        // Reuse already-created ioredis instance.
        connection: redis.bullClient as any,
      }),
    }),
    BullModule.registerQueue(
      { name: 'admin-emails' },
      { name: 'admin-alerts' },
    ),
  ],
  exports: [BullModule],
})
export class QueuesModule {}


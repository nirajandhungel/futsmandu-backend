// apps/player-api/src/modules/health/health.controller.ts
// GET /health — used by Docker HEALTHCHECK and load balancer probes.
// Checks DB connectivity, Redis connectivity, and reports queue worker count.

import { Controller, Get } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { PrismaService } from '@futsmandu/database'
import { RedisService } from '@futsmandu/redis'
import { Public } from '@futsmandu/auth'
import { ENV } from '@futsmandu/utils'

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @InjectQueue('notifications') private readonly notifQueue: Queue,
    @InjectQueue('slot-expiry')   private readonly expiryQueue: Queue,
  ) {}

  @Public()
  @Get('health')
  async check() {
    const [dbOk, redisOk, notifCounts, expiryCounts] = await Promise.all([
      this.prisma.isHealthy(),
      this.redis.ping(),
      this.notifQueue.getJobCounts().catch(() => null),
      this.expiryQueue.getJobCounts().catch(() => null),
    ])

    const healthy = dbOk && redisOk

    return {
      status: healthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      checks: {
        database: dbOk    ? 'ok' : 'error',
        redis:    redisOk ? 'ok' : 'error',
      },
      queues: {
        notifications: notifCounts ?? 'unavailable',
        slotExpiry:    expiryCounts ?? 'unavailable',
      },
      version: ENV['npm_package_version'] ?? '1.0.0',
    }
  }
}

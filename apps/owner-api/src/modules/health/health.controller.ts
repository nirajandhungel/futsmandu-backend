// apps/owner-api/src/modules/health/health.controller.ts
// FIX: Was returning static { status: 'ok' } with no real probes.
// Load balancers and Docker HEALTHCHECK were marking the service healthy even
// when Postgres was down. Now matches the same pattern used in player-api and admin-api:
//   - DB unhealthy → 503 (hard dependency)
//   - Redis unhealthy → 200 with status: 'degraded' (soft dependency)

import { Controller, Get, Res } from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { PrismaService } from '@futsmandu/database'
import { RedisService } from '@futsmandu/redis'
import { Public } from '../../common/guards/owner-jwt.guard.js'

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get('health')
  async health(@Res({ passthrough: true }) reply: FastifyReply) {
    const uptime = Math.floor(process.uptime())

    const redisOk = this.redis.isConnected()
    const dbOk    = await this.prisma.isHealthy()

    if (!dbOk) {
      reply.status(503)
      return {
        status:  'unhealthy',
        service: 'owner-api',
        db:      'down',
        redis:   redisOk ? 'connected' : 'degraded',
        uptime,
      }
    }

    reply.status(200)
    if (!redisOk) {
      return { status: 'degraded', service: 'owner-api', db: 'up', redis: 'degraded', uptime }
    }

    return { status: 'healthy', service: 'owner-api', db: 'up', redis: 'connected', uptime }
  }

  @Public()
  @Get('debug-sentry')
  getError() {
    throw new Error('My first Sentry error!')
  }
}

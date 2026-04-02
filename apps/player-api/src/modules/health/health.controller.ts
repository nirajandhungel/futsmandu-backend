// apps/player-api/src/modules/health/health.controller.ts
// GET /health — used by Docker HEALTHCHECK and load balancer probes.
// Checks DB connectivity, Redis connectivity, and reports queue worker count.

import { Controller, Get } from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import { RedisService } from '@futsmandu/redis'
import { Public } from '@futsmandu/auth'
import type { FastifyReply } from 'fastify'
import { Res } from '@nestjs/common'

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get('health')
  async check(@Res({ passthrough: true }) reply: FastifyReply) {
    const uptime = Math.floor(process.uptime())

    const redisOk = this.redis.isConnected()
    const dbOk = await this.prisma.isHealthy()

    if (!dbOk) {
      reply.status(503)
      return {
        status: 'unhealthy',
        redis: redisOk ? 'connected' : 'degraded',
        db: 'down',
        uptime,
      }
    }

    reply.status(200)
    if (!redisOk) {
      return { status: 'degraded', redis: 'degraded', db: 'up', uptime }
    }

    return { status: 'healthy', redis: 'connected', db: 'up', uptime }
  }
}

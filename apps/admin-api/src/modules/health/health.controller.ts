// apps/admin-api/src/modules/health/health.controller.ts
import { Controller, Get } from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import { RedisService } from '@futsmandu/redis'
import { AdminPublic } from '../../common/guards/admin-jwt.guard.js'

@Controller()
export class AdminHealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis:  RedisService,
  ) {}

  @AdminPublic()
  @Get('health')
  async check() {
    const [dbResult, redisResult] = await Promise.allSettled([
      this.prisma.isHealthy(),
      this.redis.ping(),
    ])
    const db      = dbResult.status    === 'fulfilled' && dbResult.value    === true
    const redis   = redisResult.status === 'fulfilled' && redisResult.value === true
    return {
      status:    db && redis ? 'healthy' : 'degraded',
      service:   'admin-api',
      timestamp: new Date().toISOString(),
      uptime:    Math.floor(process.uptime()),
      checks: { database: db ? 'ok' : 'fail', redis: redis ? 'ok' : 'fail' },
    }
  }
}

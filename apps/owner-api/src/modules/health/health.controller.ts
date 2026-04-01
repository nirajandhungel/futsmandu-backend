// apps/owner-api/src/modules/health/health.controller.ts
import { Controller, Get } from '@nestjs/common'
import { Public } from '../../common/guards/owner-jwt.guard.js'

@Controller()
export class HealthController {
  @Public()
  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'owner-api',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
    }
  }
}

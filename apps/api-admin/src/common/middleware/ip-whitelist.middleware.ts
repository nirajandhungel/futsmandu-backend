// apps/admin-api/src/common/middleware/ip-whitelist.middleware.ts
// Blocks requests from IPs not in ADMIN_ALLOWED_IPS env var.
// In development (NODE_ENV !== 'production'), all IPs are allowed.
// ADMIN_ALLOWED_IPS: comma-separated list, supports CIDR notation check via simple prefix match.
// Nginx also IP-restricts the /api/v1/admin location block — this is belt-and-suspenders.
// trustProxy: true in FastifyAdapter, so req.ip is the real client IP (from X-Forwarded-For).

import { Injectable, NestMiddleware, ForbiddenException, Logger } from '@nestjs/common'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { ENV } from '@futsmandu/utils'

@Injectable()
export class IpWhitelistMiddleware implements NestMiddleware {
  private readonly logger     = new Logger(IpWhitelistMiddleware.name)
  private readonly allowedIps: string[]
  private readonly isProd: boolean

  constructor() {
    this.isProd     = ENV['NODE_ENV'] === 'production'
    const raw       = ENV['ADMIN_ALLOWED_IPS'] ?? ''
    this.allowedIps = raw
      .split(',')
      .map(ip => ip.trim())
      .filter(Boolean)

    if (this.isProd && this.allowedIps.length === 0) {
      this.logger.warn('ADMIN_ALLOWED_IPS is empty in production — ALL IPs are blocked!')
    } else if (!this.isProd) {
      this.logger.log('IP whitelist disabled in development — all IPs allowed')
    } else {
      this.logger.log(`IP whitelist active: ${this.allowedIps.join(', ')}`)
    }
  }

  use(req: FastifyRequest['raw'], res: FastifyReply['raw'], next: () => void): void {
    // Development: skip check
    if (!this.isProd) {
      next()
      return
    }

    // Extract real IP — Fastify with trustProxy:true sets this correctly
    const clientIp = this.extractIp(req)

    if (!clientIp) {
      this.logger.warn('Could not determine client IP — blocking request')
      res.statusCode = 403
      res.end(JSON.stringify({ error: 'Access denied', code: 'IP_UNKNOWN' }))
      return
    }

    const allowed = this.allowedIps.some(allowedIp => this.matchesIp(clientIp, allowedIp))

    if (!allowed) {
      this.logger.warn(`Admin API blocked: IP ${clientIp} not in whitelist`)
      res.statusCode = 403
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        error: 'Access denied',
        code:  'IP_NOT_WHITELISTED',
        hint:  'Contact your admin to whitelist your IP address',
      }))
      return
    }

    next()
  }

  private extractIp(req: FastifyRequest['raw']): string | null {
    // X-Forwarded-For is set by Nginx with real client IP when trustProxy: true
    const forwarded = req.headers['x-forwarded-for']
    if (forwarded) {
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0]
      return first?.trim() ?? null
    }
    return req.socket?.remoteAddress ?? null
  }

  private matchesIp(clientIp: string, allowedIp: string): boolean {
    // Exact match
    if (clientIp === allowedIp) return true

    // Simple prefix match for /24 and /16 subnets (e.g., "203.0.113." prefix)
    // For full CIDR support, install 'ip-cidr' package
    if (allowedIp.endsWith('.0/24')) {
      const prefix = allowedIp.replace('.0/24', '.')
      return clientIp.startsWith(prefix)
    }
    if (allowedIp.endsWith('.0.0/16')) {
      const prefix = allowedIp.replace('.0.0/16', '.')
      return clientIp.startsWith(prefix)
    }

    return false
  }
}

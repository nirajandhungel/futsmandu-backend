import {
  Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger,
} from '@nestjs/common'
import { Observable, tap } from 'rxjs'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AuditService } from '../../audit.service.js'
import type { actor_type, action_type } from '@futsmandu/database'

const SKIP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const SENSITIVE_KEYS = new Set([
  'password', 'password_hash', 'token', 'secret', 'authorization',
  'refreshToken', 'accessToken', 'otp', 'totpCode',
])

export interface AuditInterceptorOptions {
  actorType: actor_type
  actorRole: string
  // Field in the request object where the identity is stored (e.g. 'user', 'owner', 'admin')
  identityProperty: string 
  // Segment of the URL to extract target type from (e.g. 'player', 'owner', 'admin')
  urlNamespace?: string
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name)

  constructor(
    private readonly auditService: AuditService,
    private readonly options: AuditInterceptorOptions,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest & Record<string, any>>()
    const res = ctx.switchToHttp().getResponse<FastifyReply>()
    const method = req.method?.toUpperCase() ?? 'GET'
    const url = req.url ?? ''

    if (SKIP_METHODS.has(method) || url.includes('/health') || url.includes('/api/docs')) {
      return next.handle()
    }

    const startedAt = Date.now()
    const identity = req[this.options.identityProperty]
    const actorId = identity?.id
    const action = this.resolveActionType(method) as action_type
    const requestId = String((req.headers['x-request-id'] as string | undefined) ?? req.id ?? '')

    return next.handle().pipe(
      tap({
        next: (responseBody: any) => {
          if (!actorId) return
          void this.writeAudit(actorId, action, method, url, res.statusCode, requestId, req, startedAt, responseBody)
        },
        error: (err: unknown) => {
          if (!actorId) return
          void this.writeAudit(actorId, action, method, url, res.statusCode || 500, requestId, req, startedAt, null, String(err))
        },
      }),
    )
  }

  private async writeAudit(
    actorId: string,
    action: action_type,
    method: string,
    url: string,
    statusCode: number,
    requestId: string,
    req: any,
    startedAt: number,
    responseBody: any,
    error?: string,
  ) {
    const targetType = this.extractTargetType(url)
    const targetId = this.extractTargetId(url)

    const metadata = {
      action: `${method} ${url}`,
      role: this.options.actorRole,
      identity: {
        userId: actorId,
        email: req[this.options.identityProperty]?.email ?? null,
        role: this.options.actorRole,
      },
      request: {
        method,
        endpoint: url,
        statusCode,
        requestId,
        sessionId: this.readHeader(req, 'x-session-id'),
      },
      where: this.getLocationContext(req),
      payload: {
        before: this.readBefore(req.body),
        after: error ? null : this.readAfter(req.body, responseBody),
      },
      error: error ?? null,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    }

    await this.auditService.log({
      actorType: this.options.actorType,
      actorId,
      action,
      targetType: targetType ?? undefined,
      targetId: targetId ?? undefined,
      metadata,
    })
  }

  private resolveActionType(method: string): string {
    if (method === 'POST') return 'CREATE'
    if (method === 'DELETE') return 'DELETE'
    return 'UPDATE'
  }

  private readHeader(req: FastifyRequest, key: string): string | null {
    const value = req.headers[key]
    if (!value) return null
    return Array.isArray(value) ? String(value[0]) : String(value)
  }

  private getLocationContext(req: FastifyRequest) {
    const trustedEdge = Boolean(this.readHeader(req, 'cf-ray') || this.readHeader(req, 'x-real-ip'))
    const country = trustedEdge ? (this.readHeader(req, 'cf-ipcountry') ?? this.readHeader(req, 'x-country')) : null
    const city = trustedEdge ? this.readHeader(req, 'x-city') : null
    return {
      ipAddress: req.ip ?? null,
      geoLocation: { country: country ?? null, city: city ?? null },
      geoSource: trustedEdge ? 'trusted-edge-header' : 'untrusted-none',
      userAgent: this.readHeader(req, 'user-agent'),
      device: {
        platform: this.readHeader(req, 'sec-ch-ua-platform'),
        mobile: this.readHeader(req, 'sec-ch-ua-mobile'),
      },
    }
  }

  private extractTargetId(url: string): string | null {
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    return url.match(uuidPattern)?.[0] ?? null
  }

  private extractTargetType(url: string): string | null {
    const clean = url.split('?')[0] ?? ''
    const parts = clean.split('/').filter(Boolean)
    if (this.options.urlNamespace) {
      const idx = parts.findIndex(p => p === this.options.urlNamespace)
      if (idx >= 0 && parts[idx + 1]) return parts[idx + 1]
    }
    return parts[0] ?? null
  }

  private readBefore(body: unknown): unknown {
    if (!body || typeof body !== 'object') return null
    const obj = body as Record<string, unknown>
    return this.sanitize(obj.before ?? null)
  }

  private readAfter(body: unknown, responseBody: unknown): unknown {
    if (body && typeof body === 'object') {
      const obj = body as Record<string, unknown>
      if (obj.after !== undefined) return this.sanitize(obj.after)
    }
    return this.sanitize(responseBody)
  }

  private sanitize(input: unknown): unknown {
    if (!input || typeof input !== 'object') return input
    if (Array.isArray(input)) return input.map(v => this.sanitize(v))

    const src = input as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(src)) {
      if (SENSITIVE_KEYS.has(key)) {
        out[key] = '[REDACTED]'
      } else if (typeof val === 'object' && val !== null) {
        out[key] = this.sanitize(val)
      } else {
        out[key] = val
      }
    }
    return out
  }
}

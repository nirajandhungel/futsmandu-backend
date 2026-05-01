import {
  Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger,
} from '@nestjs/common'
import { Observable, tap } from 'rxjs'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { QUEUE_AUDIT_LOGS } from '@futsmandu/queues'

const SKIP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const SENSITIVE_KEYS = new Set([
  'password', 'password_hash', 'token', 'secret', 'authorization',
  'refreshToken', 'accessToken', 'otp', 'totpCode',
])

type OwnerReq = FastifyRequest & {
  owner?: { id: string; email?: string; role?: string }
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name)

  constructor(
    @InjectQueue(QUEUE_AUDIT_LOGS) private readonly auditQueue: Queue,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<OwnerReq>()
    const res = ctx.switchToHttp().getResponse<FastifyReply>()
    const method = req.method?.toUpperCase() ?? 'GET'
    const url = req.url ?? ''
    if (SKIP_METHODS.has(method) || url.includes('/health') || url.includes('/api/docs')) {
      return next.handle()
    }

    const actorId = req.owner?.id
    const startedAt = Date.now()
    const action = this.resolveActionType(method)
    const requestId = String((req.headers['x-request-id'] as string | undefined) ?? req.id ?? '')

    return next.handle().pipe(
      tap({
        next: (responseBody) => {
          if (!actorId) return
          void this.writeAudit({
            actorId,
            action,
            role: req.owner?.role ?? 'OWNER',
            method,
            url,
            statusCode: res.statusCode,
            requestId,
            req,
            durationMs: Date.now() - startedAt,
            before: this.readBefore(req.body),
            after: this.readAfter(req.body, responseBody),
          })
        },
        error: (err: unknown) => {
          if (!actorId) return
          void this.writeAudit({
            actorId,
            action,
            role: req.owner?.role ?? 'OWNER',
            method,
            url,
            statusCode: (res.statusCode && res.statusCode > 0) ? res.statusCode : 500,
            requestId,
            req,
            durationMs: Date.now() - startedAt,
            before: this.readBefore(req.body),
            after: null,
            error: String(err),
          })
        },
      }),
    )
  }

  private async writeAudit(params: {
    actorId: string
    action: 'CREATE' | 'UPDATE' | 'DELETE'
    role: string
    method: string
    url: string
    statusCode: number
    requestId: string
    req: FastifyRequest
    durationMs: number
    before: unknown
    after: unknown
    error?: string
  }): Promise<void> {
    await this.auditQueue.add('write', {
      activity: {
        actor_type: 'OWNER',
        actor_id: params.actorId,
        action: params.action,
        target_type: this.extractTargetType(params.url),
        target_id: this.extractTargetId(params.url) ?? undefined,
        metadata: {
          action: `${params.method} ${params.url}`,
          role: params.role,
          identity: {
            userId: params.actorId,
            email: (params.req as OwnerReq).owner?.email ?? null,
            role: params.role,
          },
          request: {
            method: params.method,
            endpoint: params.url,
            statusCode: params.statusCode,
            requestId: params.requestId,
            sessionId: this.readHeader(params.req, 'x-session-id'),
          },
          where: this.getLocationContext(params.req),
          payload: { before: params.before, after: params.after },
          error: params.error ?? null,
          timestamp: new Date().toISOString(),
          durationMs: params.durationMs,
        },
      },
    }, {
      removeOnComplete: 1000,
      removeOnFail: 2000,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    }).catch((err: unknown) => this.logger.error('Failed to enqueue audit log', String(err)))
  }

  private resolveActionType(method: string): 'CREATE' | 'UPDATE' | 'DELETE' {
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
      geoLocation: {
        country: country ?? null,
        city: city ?? null,
      },
      geoSource: trustedEdge ? 'trusted-edge-header' : 'untrusted-none',
      country: country ?? null,
      city: city ?? null,
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
    const idx = parts.findIndex(p => p === 'owner')
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1]
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

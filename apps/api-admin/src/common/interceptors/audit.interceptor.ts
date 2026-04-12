// apps/admin-api/src/common/interceptors/audit.interceptor.ts
// Automatically logs all state-changing admin actions (POST/PUT/PATCH/DELETE)
// to the admin_audit_log table. Reads admin identity from request.admin (set by guard).
// Skips GET requests, health checks, and auth endpoints.
// Logs AFTER successful response — failed requests are not audit-logged
// (the exception filter handles error logging separately).

import {
  Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger,
} from '@nestjs/common'
import { Observable, tap } from 'rxjs'
import type { FastifyRequest } from 'fastify'
import { PrismaService } from '@futsmandu/database'

const SKIP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const SKIP_PATHS = ['/health', '/api/docs', '/auth/login', '/auth/refresh']

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name)

  constructor(private readonly prisma: PrismaService) { }

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { admin?: { id: string; role: string } }>()
    const method = req.method?.toUpperCase() ?? 'GET'
    const url = req.url ?? ''

    // Skip read-only + auth + health
    if (SKIP_METHODS.has(method) || SKIP_PATHS.some(p => url.includes(p))) {
      return next.handle()
    }

    const startedAt = Date.now()
    const adminId = req.admin?.id

    return next.handle().pipe(
      tap({
        next: () => {
          // Only log if we have an identified admin
          if (!adminId) return

          const action = `${method} ${url}`
          const targetId = this.extractTargetId(url)
          const targetType = this.extractTargetType(url)

          this.prisma.admin_audit_log.create({
            data: {
              admin_id: adminId,
              action,
              target_id: targetId ?? undefined,
              target_type: targetType ?? undefined,
              metadata: {
                durationMs: Date.now() - startedAt,
                body: this.sanitizeBody(req.body) as any,
              },
            },
          }).catch((err: unknown) => {
            // Never let audit logging crash the response
            this.logger.error('Failed to write audit log', String(err))
          })
        },
        error: () => {
          // Failed requests logged at warn level only — not in audit_log
          if (adminId) {
            this.logger.warn(`Admin ${adminId} failed: ${method} ${url}`)
          }
        },
      }),
    )
  }

  // Extract UUID from URL path (e.g., /users/abc-123/suspend → abc-123)
  private extractTargetId(url: string): string | null {
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    return url.match(uuidPattern)?.[0] ?? null
  }

  // Extract resource type from URL (e.g., /api/v1/admin/users/... → users)
  private extractTargetType(url: string): string | null {
    const match = url.match(/\/api\/v1\/admin\/([a-z-]+)/)
    return match?.[1] ?? null
  }

  // Remove sensitive fields from body before logging
  private sanitizeBody(body: unknown): unknown {
    if (!body || typeof body !== 'object') return body
    const safe = { ...(body as Record<string, unknown>) }
    for (const key of ['password', 'password_hash', 'token', 'secret', 'totpCode']) {
      if (key in safe) safe[key] = '[REDACTED]'
    }
    return safe
  }
}

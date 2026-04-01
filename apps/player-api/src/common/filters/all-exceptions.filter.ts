// CHANGED: [L-3 Sentry init/capture, P2024 pool-timeout 503 response]
// NEW ISSUES FOUND:
//   - Sentry was referenced but never imported/initialized (L-3)
//   - P2024 (connection pool timeout) was not handled — results in a generic 500

// apps/player-api/src/common/filters/all-exceptions.filter.ts
// Maps domain exceptions and Prisma errors to correct HTTP status codes.
// Never exposes stack traces in production.

import {
  ExceptionFilter, Catch, ArgumentsHost,
  HttpException, Logger,
} from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import * as Sentry from '@sentry/node'
import { ENV } from '@futsmandu/utils'

// L-3: Sentry is initialised once when this module is first imported.
// SENTRY_DSN must be set in .env — validated at startup in main.ts.
if (ENV['SENTRY_DSN']) {
  Sentry.init({
    dsn: ENV['SENTRY_DSN'],
    environment: ENV['NODE_ENV'] ?? 'development',
    tracesSampleRate: ENV['NODE_ENV'] === 'production' ? 0.1 : 1.0,
  })
}

interface PrismaError extends Error {
  code?: string
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name)
  private readonly isProd = ENV['NODE_ENV'] === 'production'

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx   = host.switchToHttp()
    const reply = ctx.getResponse<FastifyReply>()

    // ── NestJS HTTP exceptions ───────────────────────────────────────────
    if (exception instanceof HttpException) {
      const status   = exception.getStatus()
      const response = exception.getResponse()
      void reply.status(status).send(
        typeof response === 'string'
          ? { error: response, code: 'HTTP_ERROR', statusCode: status }
          : { ...(response as object), statusCode: status },
      )
      return
    }

    // ── Prisma errors ────────────────────────────────────────────────────
    const prismaErr = exception as PrismaError
    if (prismaErr?.code === 'P2002') {
      void reply.status(409).send({ error: 'Slot already booked', code: 'SLOT_CONFLICT', statusCode: 409 })
      return
    }
    if (prismaErr?.code === 'P2034') {
      void reply.status(409).send({ error: 'Transaction conflict — please retry', code: 'TX_CONFLICT', statusCode: 409, retryable: true })
      return
    }
    if (prismaErr?.code === 'P2025') {
      void reply.status(404).send({ error: 'Record not found', code: 'NOT_FOUND', statusCode: 404 })
      return
    }
    // P2024: Connection pool timeout — shed load gracefully
    if (prismaErr?.code === 'P2024') {
      void reply.status(503).send({
        error: 'Service temporarily overloaded — please retry in a moment',
        code: 'POOL_TIMEOUT',
        statusCode: 503,
        retryable: true,
      })
      return
    }

    // ── Unknown errors — capture to Sentry ───────────────────────────────
    if (ENV['SENTRY_DSN'] && exception instanceof Error) {
      Sentry.captureException(exception)
    }

    this.logger.error(
      'Unhandled exception',
      exception instanceof Error ? exception.stack : String(exception),
    )
    void reply.status(500).send({
      error: this.isProd
        ? 'Internal server error'
        : String((exception as Error)?.message ?? exception),
      code: 'SERVER_ERROR',
      statusCode: 500,
    })
  }
}

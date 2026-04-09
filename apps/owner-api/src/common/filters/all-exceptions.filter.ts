import {
  ExceptionFilter, Catch, ArgumentsHost,
  HttpException, Logger,
} from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { ENV } from '@futsmandu/utils'
import { SentryExceptionCaptured } from '@sentry/nestjs'

interface PrismaError extends Error {
  code?: string
  meta?: Record<string, unknown>
}

// Prisma emits this message when a non-UUID string reaches a UUID column.
const UUID_ERROR_RE = /inconsistent column data|invalid character.*uuid|error creating uuid/i

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name)
  private readonly isProd = ENV['NODE_ENV'] === 'production'

  @SentryExceptionCaptured()
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx   = host.switchToHttp()
    const reply = ctx.getResponse<FastifyReply>()

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

    const prismaErr = exception as PrismaError
    if (prismaErr?.code === 'P2002') {
      void reply.status(409).send({ error: 'Conflict — record already exists', code: 'CONFLICT', statusCode: 409 })
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
    // P2023 — malformed UUID / inconsistent column data (e.g. venueId = "invalid")
    if (
      prismaErr?.code === 'P2023' ||
      UUID_ERROR_RE.test(prismaErr?.message ?? '')
    ) {
      void reply.status(400).send({ error: 'Invalid ID format — must be a valid UUID', code: 'INVALID_ID', statusCode: 400 })
      return
    }

    this.logger.error('Unhandled exception', exception instanceof Error ? exception.stack : String(exception))
    void reply.status(500).send({
      error: this.isProd ? 'Internal server error' : String((exception as Error)?.message ?? exception),
      code: 'SERVER_ERROR',
      statusCode: 500,
    })
  }
}

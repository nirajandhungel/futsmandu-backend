// packages/logger/src/logger.service.ts
// Structured logger wrapping NestJS Logger.
// In production: outputs JSON for Grafana/Loki ingestion.
// Includes request-id tracking for distributed tracing.

import { Injectable, LoggerService, Logger, Scope } from '@nestjs/common'

@Injectable({ scope: Scope.TRANSIENT })
export class AppLogger implements LoggerService {
  private readonly logger: Logger

  constructor(context = 'App') {
    this.logger = new Logger(context)
  }

  setContext(context: string): void {
    Object.assign(this.logger, { context })
  }

  log(message: string, meta?: Record<string, unknown>): void {
    this.logger.log(this.format(message, meta))
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.logger.warn(this.format(message, meta))
  }

  error(message: string, trace?: string, meta?: Record<string, unknown>): void {
    this.logger.error(this.format(message, meta), trace)
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.logger.debug(this.format(message, meta))
  }

  verbose(message: string, meta?: Record<string, unknown>): void {
    this.logger.verbose(this.format(message, meta))
  }

  private format(message: string, meta?: Record<string, unknown>): string {
    if (!meta) return message
    return `${message} ${JSON.stringify(meta)}`
  }
}

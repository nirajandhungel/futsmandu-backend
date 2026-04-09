// packages/sentry/src/capture.ts
import * as Sentry from '@sentry/nestjs'

export function captureException(error: unknown, context?: Record<string, any>) {
  if (process.env['SENTRY_DSN']) {
    Sentry.captureException(error, { extra: context })
  }
}
// packages/sentry/src/init.ts
import * as Sentry from '@sentry/nestjs'
import { nodeProfilingIntegration } from '@sentry/profiling-node'

export function initSentry() {
  const dsn = process.env['SENTRY_DSN']
  if (!dsn) {
    console.warn('SENTRY_DSN not set, Sentry not initialized')
    return
  }

  Sentry.init({
    dsn,
    environment: process.env['SENTRY_ENVIRONMENT'] || process.env['NODE_ENV'] || 'development',
    release: process.env['SENTRY_RELEASE'] || process.env['npm_package_version'],
    integrations: [
      nodeProfilingIntegration(),
    ],
    // Performance Monitoring
    tracesSampleRate: parseFloat(process.env['SENTRY_TRACES_SAMPLE_RATE'] || '0.1'),
    profilesSampleRate: 0.1,

    // Security & Privacy
    sendDefaultPii: false,

    // Error Filtering - ignore common validation and auth errors
    ignoreErrors: [
      'ValidationError',
      'UnauthorizedException',
      'ForbiddenException',
      'NotFoundException',
    ],

    // Sensitive Data Stripping
    beforeSend(event) {
      if (event.request?.headers) {
        delete event.request.headers['authorization']
        delete event.request.headers['cookie']
        delete event.request.headers['x-api-key']
      }
      return event
    },
  })
}
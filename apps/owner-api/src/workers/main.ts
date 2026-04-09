// IMPORTANT: Sentry instrumentation must be imported before any other module
import '../instrument.js'

// apps/owner-api/src/workers/main.ts
// Owner worker process entry — separate from API HTTP server.
// Processes: notifications, emails, sms, image-processing queues.
import { NestFactory } from '@nestjs/core'
import { Logger } from '@nestjs/common'
import { OwnerWorkerModule } from './worker.module.js'
import { RedisService, markRedisShuttingDown } from '@futsmandu/redis'
import { ENV } from '@futsmandu/utils'
import { EventEmitter } from 'events'

// Raise the default max-listeners ceiling before any module registers listeners.
EventEmitter.defaultMaxListeners = 20

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(OwnerWorkerModule, {
    logger: ENV['NODE_ENV'] === 'production'
      ? ['warn', 'error']
      : ['log', 'debug', 'warn', 'error'],
  })

  // ── Wait for Redis before BullMQ registers processors ──────────────────────
  // Prevents "Stream isn't writeable" cascade caused by BullMQ issuing
  // commands before the TLS handshake completes.
  const redis = app.get(RedisService)
  await redis.waitForReady()

  await app.init()

  const logger = new Logger('OwnerWorker')
  logger.log('🔧 Owner worker started — processing: notifications, owner-emails, sms, image-processing')

  // Log S3/MinIO connection status
  const s3Endpoint = ENV['S3_ENDPOINT']
  const s3Bucket = ENV['S3_BUCKET']
  if (s3Endpoint && s3Bucket) {
    const isMinIO = s3Endpoint.includes('localhost') || s3Endpoint.includes('127.0.0.1')
    logger.log(`🪣 ${isMinIO ? 'MinIO' : 'S3'} connected: ${s3Endpoint} → ${s3Bucket}`)
  } else {
    logger.warn(`🪣 S3/MinIO not configured — image processing disabled`)
  }

  // Log Sentry status
  if (ENV['SENTRY_DSN']) {
    logger.log(`🐛 Sentry enabled: ${ENV['SENTRY_ENVIRONMENT']} (${ENV['SENTRY_RELEASE']})`)
  } else {
    logger.warn(`🐛 Sentry disabled — worker errors not monitored`)
  }

  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']
  for (const signal of signals) {
    process.on(signal, async () => {
      logger.log(`${signal} received — draining owner worker queues gracefully`)
      markRedisShuttingDown()
      await app.close()
      logger.log(`✅ Owner worker shutdown complete`)
      process.exit(0)
    })
  }
}

bootstrap().catch((err: unknown) => {
  new Logger('OwnerWorker').error('Fatal startup error', String(err))
  process.exit(1)
})

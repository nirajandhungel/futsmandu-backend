// IMPORTANT: Sentry instrumentation must be imported before any other module
import '../instrument.js'

// apps/admin-api/src/workers/main.ts
import { NestFactory } from '@nestjs/core'
import { Logger } from '@nestjs/common'
import { AdminWorkerModule } from './worker.module.js'
import { RedisService, markRedisShuttingDown } from '@futsmandu/redis'
import { ENV } from '@futsmandu/utils'
import { EventEmitter } from 'events'

// Raise the default max-listeners ceiling before any module registers listeners.
EventEmitter.defaultMaxListeners = 20

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AdminWorkerModule, {
    logger: ENV['NODE_ENV'] === 'production' ? ['warn', 'error'] : ['log', 'debug', 'warn', 'error'],
  })

  // ── Wait for Redis before BullMQ registers processors ──────────────────────
  // Prevents "Stream isn't writeable" cascade caused by BullMQ issuing
  // commands before the TLS handshake completes.
  const redis = app.get(RedisService)
  await redis.waitForReady()

  await app.init()

  const logger = new Logger('AdminWorker')
  logger.log('🔐 Admin worker started — processing: admin-emails, admin-alerts')

  // Log S3/MinIO connection status
  const s3Endpoint = ENV['S3_ENDPOINT']
  const s3Bucket = ENV['S3_BUCKET']
  if (s3Endpoint && s3Bucket) {
    const isMinIO = s3Endpoint.includes('localhost') || s3Endpoint.includes('127.0.0.1')
    logger.log(`🪣 ${isMinIO ? 'MinIO' : 'S3'} connected: ${s3Endpoint} → ${s3Bucket}`)
  } else {
    logger.warn(`🪣 S3/MinIO not configured — admin operations may fail`)
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
      logger.log(`${signal} received — draining admin worker gracefully`)
      markRedisShuttingDown()
      await app.close()
      logger.log(`✅ Admin worker shutdown complete`)
      process.exit(0)
    })
  }
}

bootstrap().catch((err: unknown) => {
  new Logger('AdminWorker').error('Fatal startup error', String(err))
  process.exit(1)
})

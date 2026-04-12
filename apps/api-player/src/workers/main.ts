// IMPORTANT: Sentry instrumentation must be imported before any other module
import '../instrument.js'

// apps/player-api/src/workers/main.ts
// BullMQ worker process — runs SEPARATELY from the NestJS API server.
// Uses NestJS application context for DI (PrismaService, RedisService, etc.)
// Each processor is a NestJS @Processor — same DI container, no code duplication.

import { NestFactory } from '@nestjs/core'
import { Logger } from '@nestjs/common'
import { WorkerModule } from './worker.module.js'
import { RedisService, markRedisShuttingDown } from '@futsmandu/redis'
import { EventEmitter } from 'events'

// Raise the default max-listeners ceiling before any module registers listeners.
EventEmitter.defaultMaxListeners = 20

async function bootstrap() {
  const logger = new Logger('Workers')

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['log', 'warn', 'error'],
  })

  // ── Wait for Redis before BullMQ registers processors ──────────────────────
  // BullMQ immediately issues BZPOPMIN after NestJS wires up @Processor
  // decorators.  If the ioredis socket is still completing its TLS handshake
  // those commands hit a non-ready stream → "Stream isn't writeable" cascade.
  // Waiting here ensures the socket is fully ready before processors run.
  const redis = app.get(RedisService)
  await redis.waitForReady()

  await app.init()
  logger.log('🔧 All BullMQ workers started')

  // Log S3/MinIO connection status
  const s3Endpoint = process.env['S3_ENDPOINT']
  const s3Bucket = process.env['S3_BUCKET']
  if (s3Endpoint && s3Bucket) {
    const isMinIO = s3Endpoint.includes('localhost') || s3Endpoint.includes('127.0.0.1')
    logger.log(`🪣 ${isMinIO ? 'MinIO' : 'S3'} connected: ${s3Endpoint} → ${s3Bucket}`)
  } else {
    logger.warn(`🪣 S3/MinIO not configured — image processing disabled`)
  }

  // Log Sentry status
  if (process.env['SENTRY_DSN']) {
    logger.log(`🐛 Sentry enabled: ${process.env['SENTRY_ENVIRONMENT']} (${process.env['SENTRY_RELEASE']})`)
  } else {
    logger.warn(`🐛 Sentry disabled — worker errors not monitored`)
  }

  const shutdown = async (sig: string) => {
    new Logger('Workers').log(`${sig} — shutting down workers gracefully`)
    markRedisShuttingDown()
    await app.close()
    new Logger('Workers').log(`✅ Player workers shutdown complete`)
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

bootstrap().catch(err => {
  new Logger('Workers').error('Fatal worker startup error', err)
  process.exit(1)
})

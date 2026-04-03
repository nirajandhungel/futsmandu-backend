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

  const shutdown = async (sig: string) => {
    new Logger('Workers').log(`${sig} — shutting down workers`)
    markRedisShuttingDown()
    await app.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

bootstrap().catch(err => {
  new Logger('Workers').error('Fatal worker startup error', err)
  process.exit(1)
})

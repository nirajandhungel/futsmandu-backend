// apps/owner-api/src/workers/main.ts
// Owner worker process entry — separate from API HTTP server.
// Processes: notifications, emails, sms, image-processing queues.
import { NestFactory } from '@nestjs/core'
import { Logger } from '@nestjs/common'
import { OwnerWorkerModule } from './worker.module.js'
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

  const logger = new Logger('OwnerWorker')
  logger.log('🔧 Owner worker started — processing: notifications, owner-emails, sms, image-processing')

  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']
  for (const signal of signals) {
    process.on(signal, async () => {
      logger.log(`${signal} received — draining owner worker queues`)
      await app.close()
      process.exit(0)
    })
  }
}

bootstrap().catch((err: unknown) => {
  new Logger('OwnerWorker').error('Fatal startup error', String(err))
  process.exit(1)
})

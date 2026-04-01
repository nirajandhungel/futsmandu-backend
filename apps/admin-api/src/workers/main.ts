// apps/admin-api/src/workers/main.ts
import { NestFactory } from '@nestjs/core'
import { Logger } from '@nestjs/common'
import { AdminWorkerModule } from './worker.module.js'
import { ENV } from '@futsmandu/utils'
import { EventEmitter } from 'events'

// Raise the default max-listeners ceiling before any module registers listeners.
EventEmitter.defaultMaxListeners = 20

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AdminWorkerModule, {
    logger: ENV['NODE_ENV'] === 'production' ? ['warn', 'error'] : ['log', 'debug', 'warn', 'error'],
  })

  const logger = new Logger('AdminWorker')
  logger.log('🔐 Admin worker started — processing: admin-emails, admin-alerts')

  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']
  for (const signal of signals) {
    process.on(signal, async () => {
      logger.log(`${signal} received — draining admin worker`)
      await app.close()
      process.exit(0)
    })
  }
}

bootstrap().catch((err: unknown) => {
  new Logger('AdminWorker').error('Fatal startup error', String(err))
  process.exit(1)
})

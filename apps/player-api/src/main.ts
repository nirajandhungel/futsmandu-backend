// IMPORTANT: Sentry instrumentation must be imported before any other module
import './instrument.js'

// CHANGED: [L-4 startup env validation, L-3 Sentry init via filter, SanitizePipe registration]
// NEW ISSUES FOUND:
//   - No startup validation of critical env vars — missing secrets caused cryptic runtime crashes
//   - SanitizePipe not registered globally

// apps/player-api/src/main.ts
// NestJS bootstrapped with FastifyAdapter.
// Fails fast at startup if any required env var is missing.

import { NestFactory, Reflector } from '@nestjs/core'
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify'
import { ValidationPipe, Logger } from '@nestjs/common'
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger'
import fastifyHelmet from '@fastify/helmet'
import fastifyCookie from '@fastify/cookie'
import { AppModule } from './app.module.js'
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js'
import { ResponseInterceptor } from './common/interceptors/response.interceptor.js'
import { SanitizePipe } from './common/pipes/sanitize.pipe.js'
import { JwtAuthGuard } from '@futsmandu/auth'
import { ENV, validateENV } from '@futsmandu/utils'
import { markRedisShuttingDown } from '@futsmandu/redis'
import { EventEmitter } from 'events'

// Raise the default max-listeners ceiling before any module registers listeners.
EventEmitter.defaultMaxListeners = 20

// ── Startup env validation ────────────────────────────────────────────────────
// Fail immediately with a clear message rather than crashing with a cryptic
// error at first request when a secret is undefined.
function validateEnv(): void {
  // Delegates DATABASE_URL, DIRECT_DATABASE_URL, UPSTASH_REDIS_IOREDIS_URL
  // (+ rediss:// format check) to the centralized validator.
  validateENV(['PLAYER_JWT_SECRET', 'KHALTI_SECRET_KEY', 'ESEWA_SECRET_KEY', 'ESEWA_PRODUCT_CODE', 'APP_URL'])

  if ((ENV.PLAYER_JWT_SECRET?.length ?? 0) < 32) {
    console.error('[ENV] FATAL — PLAYER_JWT_SECRET must be at least 32 characters')
    process.exit(1)
  }

  // Firebase is optional — warn rather than exit.
  if (ENV.FIREBASE_SERVICE_ACCOUNT) {
    const val = ENV.FIREBASE_SERVICE_ACCOUNT
    if (!val.startsWith('{') && !val.endsWith('.json')) {
      console.warn('[Bootstrap] WARNING: FIREBASE_SERVICE_ACCOUNT is neither a JSON string nor a .json path — FCM may fail.')
    }
  } else {
    console.warn('[Bootstrap] WARNING: FIREBASE_SERVICE_ACCOUNT not set — FCM push notifications disabled')
  }
}

const PORT = parseInt(ENV['PLAYER_API_PORT'] ?? '3001', 10)
const HOST = '0.0.0.0'
const IS_PROD = ENV['NODE_ENV'] === 'production'

async function bootstrap(): Promise<void> {
  validateEnv()

  // Probe for pino-pretty using a dynamic import() — works in both CJS and ESM output.
  const HAS_PINO_PRETTY = await import('pino-pretty').then(() => true).catch(() => false)

  const adapter = new FastifyAdapter({
    logger: IS_PROD
      ? { level: 'warn' }
      : HAS_PINO_PRETTY
        ? { level: 'info', transport: { target: 'pino-pretty', options: { colorize: true } } }
        : { level: 'info' },
    trustProxy: true,
    bodyLimit: 1_048_576,
    requestTimeout: 30_000,
    connectionTimeout: 60_000,
  })

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: IS_PROD ? ['warn', 'error'] : ['log', 'debug', 'verbose', 'warn', 'error'],
    bufferLogs: true,
  })

  await app.register(fastifyHelmet as any, {
    contentSecurityPolicy: false,
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
  })

  await app.register(fastifyCookie as any)

  app.enableCors({
    origin: IS_PROD
      ? ['https://futsmandu.app', 'https://www.futsmandu.app']
      : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })

  // ValidationPipe — whitelist + transform
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
    // SanitizePipe runs after ValidationPipe — trims, strips HTML, lowercases email
    new SanitizePipe(),
  )

  const reflector = app.get(Reflector)
  app.useGlobalGuards(new JwtAuthGuard(reflector))
  app.useGlobalFilters(new AllExceptionsFilter())
  app.useGlobalInterceptors(new ResponseInterceptor())

  app.setGlobalPrefix('api/v1/player')

  if (!IS_PROD) {
    const config = new DocumentBuilder()
      .setTitle('Futsmandu Player API')
      .setDescription('Player-facing API — bookings, payments, social, discovery')
      .setVersion('1.0')
      .addBearerAuth()
      .build()
    const document = SwaggerModule.createDocument(app, config)
    SwaggerModule.setup('api/docs', app, document)
    new Logger('Swagger').log('📖 Docs: http://localhost:3001/api/docs')
  }

  await app.listen(PORT, HOST)

  const logger = new Logger('Bootstrap')
  logger.log(`🚀 Player API ready at http://${HOST}:${PORT}/api/v1/player`)
  logger.log(`   Environment: ${ENV['NODE_ENV']}`)
  logger.log(`   DB pool size per instance: ${ENV['DB_POOL_SIZE'] ?? 5}`)

  // Log S3/MinIO connection status
  const s3Endpoint = ENV['S3_ENDPOINT']
  const s3Bucket = ENV['S3_BUCKET']
  if (s3Endpoint && s3Bucket) {
    const isMinIO = s3Endpoint.includes('localhost') || s3Endpoint.includes('127.0.0.1')
    logger.log(`🪣 ${isMinIO ? 'MinIO' : 'S3'} connected: ${s3Endpoint} → ${s3Bucket}`)
  } else {
    logger.warn(`🪣 S3/MinIO not configured — media uploads disabled`)
  }

  // Log Sentry status
  if (ENV['SENTRY_DSN']) {
    logger.log(`🐛 Sentry enabled: ${ENV['SENTRY_ENVIRONMENT']} (${ENV['SENTRY_RELEASE']})`)
  } else {
    logger.warn(`🐛 Sentry disabled — no DSN configured`)
  }

  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']
  for (const signal of signals) {
    process.on(signal, async () => {
      logger.log(`${signal} received — shutting down player-api gracefully`)
      markRedisShuttingDown()
      await app.close()
      logger.log(`✅ Player API shutdown complete`)
      process.exit(0)
    })
  }
}

bootstrap().catch((err: unknown) => {
  new Logger('Bootstrap').error('Fatal startup error', String(err))
  process.exit(1)
})

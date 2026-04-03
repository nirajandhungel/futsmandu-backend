// apps/owner-api/src/main.ts
// Owner API — NestJS 10 + FastifyAdapter.
// Port 3002 — dedicated server for venue owners via Flutter mobile app.
// CORS: Flutter mobile app (no browser origin restriction needed, but locked to app origin).
// Multipart: @fastify/multipart registered for image uploads.
// JWT: OWNER_JWT_SECRET — completely separate from player and admin.

import { NestFactory, Reflector } from '@nestjs/core'
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify'
import { ValidationPipe, Logger } from '@nestjs/common'
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger'
import fastifyHelmet from '@fastify/helmet'
import fastifyCookie from '@fastify/cookie'
import fastifyMultipart from '@fastify/multipart'
import { AppModule } from './app.module.js'
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js'
import { ResponseInterceptor } from './common/interceptors/response.interceptor.js'
import { ENV, validateENV } from '@futsmandu/utils'
import { markRedisShuttingDown } from '@futsmandu/redis'
import { EventEmitter } from 'events'

// Raise the default max-listeners ceiling before any module registers listeners.
EventEmitter.defaultMaxListeners = 20

function validateEnv(): void {
  // Delegates DATABASE_URL, DIRECT_DATABASE_URL, UPSTASH_REDIS_IOREDIS_URL
  // (+ rediss:// format check) to the centralized validator.
  validateENV([
    'OWNER_JWT_SECRET',
    'CF_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
    'R2_CDN_BASE_URL',
  ])

  if ((ENV.OWNER_JWT_SECRET?.length ?? 0) < 32) {
    console.error('[ENV] FATAL — OWNER_JWT_SECRET must be at least 32 characters')
    process.exit(1)
  }

  // Firebase is optional — warn rather than exit.
  if (ENV.FIREBASE_SERVICE_ACCOUNT) {
    const val = ENV.FIREBASE_SERVICE_ACCOUNT
    if (!val.startsWith('{') && !val.endsWith('.json')) {
      console.warn('[Bootstrap] WARNING: FIREBASE_SERVICE_ACCOUNT is neither a JSON string nor a .json path — FCM may fail.')
    }
  } else {
    console.warn('[Bootstrap] WARNING: FIREBASE_SERVICE_ACCOUNT not set — owner FCM push disabled')
  }
}

const PORT = parseInt(ENV['OWNER_API_PORT'] ?? '3002', 10)
const HOST = '0.0.0.0'
const IS_PROD = ENV['NODE_ENV'] === 'production'

async function bootstrap(): Promise<void> {
  validateEnv()

  const HAS_PINO_PRETTY = await import('pino-pretty').then(() => true).catch(() => false)

  const adapter = new FastifyAdapter({
    logger: IS_PROD
      ? { level: 'warn' }
      : HAS_PINO_PRETTY
        ? { level: 'info', transport: { target: 'pino-pretty', options: { colorize: true } } }
        : { level: 'info' },
    trustProxy: true,
    // 5MB body limit — owner uploads venue images via presigned URL (no direct upload through server)
    // Multipart is registered separately with its own limit
    bodyLimit: 5_242_880,
    requestTimeout: 60_000,
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

  await app.register(fastifyCookie as any, {
    secret: ENV['OWNER_JWT_SECRET'],
    hook: 'onRequest',
  })

  // Multipart for direct image/document uploads (max 5MB per file, 5 files at once)
  await app.register(fastifyMultipart as any, {
    limits: {
      fileSize: 5 * 1024 * 1024,
      files: 5,
    },
  })

  // CORS: Flutter mobile app doesn't send an Origin header on direct API calls.
  // Allow defined web origins + mobile (origin: true allows any origin in dev).
  // In production, Flutter apps typically don't use browser CORS — this is belt-and-suspenders.
  app.enableCors({
    origin: IS_PROD
      ? [
        'https://futsmandu.app',
        'https://owner.futsmandu.app',
        // Flutter app: typically no browser origin — handle via token auth instead
      ]
      : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  })

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  )

  app.useGlobalFilters(new AllExceptionsFilter())
  app.useGlobalInterceptors(new ResponseInterceptor())

  // Separate global prefix from admin-api
  app.setGlobalPrefix('api/v1/owner')

  if (!IS_PROD) {
    const config = new DocumentBuilder()
      .setTitle('Futsmandu Owner API')
      .setDescription('Venue owner management — courts, bookings, analytics, media. Used by Flutter mobile app.')
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'Owner-JWT')
      .build()
    const document = SwaggerModule.createDocument(app, config)
    SwaggerModule.setup('api/docs', app, document)
    new Logger('Swagger').log(`📖 Owner API Docs: http://localhost:${PORT}/api/docs`)
  }

  await app.listen(PORT, HOST)

  const logger = new Logger('Bootstrap')
  logger.log(`🏢 Owner API ready at http://${HOST}:${PORT}/api/v1/owner`)
  logger.log(`   Environment: ${ENV['NODE_ENV']}`)
  logger.log(`   DB pool size: ${ENV['DB_POOL_SIZE'] ?? 5}`)

  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']
  for (const signal of signals) {
    process.on(signal, async () => {
      logger.log(`${signal} received — shutting down owner-api`)
      markRedisShuttingDown()
      await app.close()
      process.exit(0)
    })
  }
}

bootstrap().catch((err: unknown) => {
  new Logger('Bootstrap').error('Fatal startup error in owner-api', String(err))
  process.exit(1)
})

// IMPORTANT: Sentry instrumentation must be imported before any other module
import './instrument.js'

// apps/admin-api/src/main.ts
// Admin API — NestJS 10 + FastifyAdapter.
// Port 3003 — ONLY accessible from admin web dashboard (Next.js).
// CORS: locked to admin.futsmandu.app only (web browser, not mobile).
// IP Whitelist: enforced at middleware level (office IPs only).
// JWT: ADMIN_JWT_SECRET — 8h sessions, 2FA enforced in production.
// No multipart — admin never uploads files directly (uses presigned R2 URLs).

import * as zlib from 'node:zlib'
import { NestFactory } from '@nestjs/core'
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify'
import { ValidationPipe, Logger } from '@nestjs/common'
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger'
import fastifyHelmet from '@fastify/helmet'
import fastifyCookie from '@fastify/cookie'
import fastifyCompress from '@fastify/compress'
import { AppModule } from './app.module.js'
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js'
import { ResponseInterceptor } from './common/interceptors/response.interceptor.js'
import { ENV, validateENV } from '@futsmandu/utils'
import { markRedisShuttingDown } from '@futsmandu/redis'
import { EventEmitter } from 'events'

// Raise the default max-listeners ceiling before any module registers listeners.
EventEmitter.defaultMaxListeners = 20

function validateEnv(): void {
  // Delegate all common + Redis checks to the centralized validator.
  // Pass admin-specific required keys as extras.
  validateENV(['ADMIN_JWT_SECRET'])

  const minSecretLength = ENV.NODE_ENV === 'production' ? 64 : 32
  if ((ENV.ADMIN_JWT_SECRET?.length ?? 0) < minSecretLength) {
    console.error(
      `[ENV] FATAL — ADMIN_JWT_SECRET must be at least ${minSecretLength} characters` +
      (ENV.NODE_ENV === 'production' ? ' (use: openssl rand -base64 64)' : ''),
    )
    process.exit(1)
  }
  if (ENV.NODE_ENV === 'production' && !ENV.ADMIN_ALLOWED_IPS) {
    console.error('[ENV] FATAL — ADMIN_ALLOWED_IPS must be set in production')
    process.exit(1)
  }
}

const PORT = parseInt(ENV['ADMIN_API_PORT'] ?? '3003', 10)
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
    trustProxy: '172.20.0.0/16',
    bodyLimit: 1_048_576, // 1MB — admin never uploads large files
    requestTimeout: 30_000,
    connectionTimeout: 60_000,
    keepAliveTimeout: 75_000,
    routerOptions: { ignoreTrailingSlash: true },
    disableRequestLogging: IS_PROD,
  })

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: IS_PROD ? ['warn', 'error'] : ['log', 'debug', 'verbose', 'warn', 'error'],
    bufferLogs: true,
  })

  await app.register(fastifyHelmet as any, {
    contentSecurityPolicy: IS_PROD ? undefined : false, // Strict CSP in prod for admin panel
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
    frameguard: { action: 'deny' }, // Admin panel must never be embedded in iframes
  })

  // Brotli/gzip compression for all responses ≥1KB
  await app.register(fastifyCompress as any, {
    global: true,
    threshold: 1024,
    encodings: ['br', 'gzip'],
    brotliOptions: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } },
  })

  // HTTP-only cookie for admin sessions (browser-based dashboard)
  await app.register(fastifyCookie as any) // CORS: browser-only, locked to admin subdomain
  // Admin tokens are in HTTP-only cookies — SameSite=Strict handles CSRF
  app.enableCors({
    origin: IS_PROD
  ? ['https://admin.futsmandu.app']
  : [
      'http://localhost',
      'http://localhost:5173',
      'http://localhost:5174'
    ],
    credentials: true, // Required for HTTP-only cookie auth
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Admin-Token'],
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
  app.useGlobalInterceptors(
    new ResponseInterceptor(),
  )

  // Separate prefix — /api/v1/admin (not /api/v1/owner)
  app.setGlobalPrefix('api/v1/admin')

  if (!IS_PROD) {
    const config = new DocumentBuilder()
      .setTitle('Futsmandu Admin API')
      .setDescription('Internal admin dashboard API — user management, moderation, verification, analytics. Web only.')
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'Admin-JWT')
      .addApiKey({ type: 'apiKey', in: 'cookie', name: 'admin_token' }, 'Admin-Cookie')
      .build()
    const document = SwaggerModule.createDocument(app, config)
    SwaggerModule.setup('api/docs', app, document)
    new Logger('Swagger').log(`📖 Admin API Docs: http://localhost:${PORT}/api/docs`)
  }

  await app.listen(PORT, HOST)

  const logger = new Logger('Bootstrap')
  logger.log(`🔐 Admin API ready at http://${HOST}:${PORT}/api/v1/admin`)
  logger.log(`   Environment: ${ENV['NODE_ENV']}`)
  logger.log(`   IP Whitelist: ${ENV['ADMIN_ALLOWED_IPS'] ?? 'DISABLED (dev mode)'}`)

  // Log S3/MinIO connection status
  const s3Endpoint = ENV['S3_ENDPOINT']
  const s3Bucket = ENV['S3_BUCKET']
  if (s3Endpoint && s3Bucket) {
    const isMinIO = s3Endpoint.includes('localhost') || s3Endpoint.includes('127.0.0.1')
    logger.log(`🪣 ${isMinIO ? 'MinIO' : 'S3'} connected: ${s3Endpoint} → ${s3Bucket}`)
  } else {
    logger.warn(`🪣 S3/MinIO not configured — media operations may fail`)
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
      logger.log(`${signal} received — shutting down admin-api gracefully`)
      markRedisShuttingDown()
      await app.close()
      logger.log(`✅ Admin API shutdown complete`)
      process.exit(0)
    })
  }
}

bootstrap().catch((err: unknown) => {
  new Logger('Bootstrap').error('Fatal startup error in admin-api', String(err))
  process.exit(1)
})

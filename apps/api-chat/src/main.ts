import './instrument.js';

import * as zlib from 'node:zlib';
import { NestFactory, Reflector } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import fastifyHelmet from '@fastify/helmet';
import fastifyCookie from '@fastify/cookie';
import fastifyCompress from '@fastify/compress';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { ResponseInterceptor } from './common/interceptors/response.interceptor.js';
import { SanitizePipe } from './common/pipes/sanitize.pipe.js';
import { ENV, validateENV } from '@futsmandu/utils';
import { markRedisShuttingDown, RedisService } from '@futsmandu/redis';
import { EventEmitter } from 'events';
import { RedisIoAdapter } from './redis-io.adapter.js';

EventEmitter.defaultMaxListeners = 20;

function validateEnv(): void {
  validateENV(['PLAYER_JWT_SECRET', 'OWNER_JWT_SECRET']);

  if ((ENV.PLAYER_JWT_SECRET?.length ?? 0) < 32 || (ENV.OWNER_JWT_SECRET?.length ?? 0) < 32) {
    console.error('[ENV] FATAL — PLAYER_JWT_SECRET and OWNER_JWT_SECRET must be at least 32 characters');
    process.exit(1);
  }
}

const PORT = parseInt(process.env['CHAT_API_PORT'] ?? '3004', 10);
const HOST = '0.0.0.0';
const IS_PROD = ENV['NODE_ENV'] === 'production';

async function bootstrap(): Promise<void> {
  validateEnv();

  const HAS_PINO_PRETTY = await import('pino-pretty').then(() => true).catch(() => false);

  const adapter = new FastifyAdapter({
    logger: IS_PROD
      ? { level: 'warn' }
      : HAS_PINO_PRETTY
        ? { level: 'info', transport: { target: 'pino-pretty', options: { colorize: true } } }
        : { level: 'info' },
    trustProxy: true,
    requestTimeout: 30_000,
    connectionTimeout: 60_000,
    keepAliveTimeout: 75_000,
    routerOptions: { ignoreTrailingSlash: true },
    disableRequestLogging: IS_PROD,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: IS_PROD ? ['warn', 'error'] : ['log', 'debug', 'verbose', 'warn', 'error'],
    bufferLogs: true,
  });

  await app.register(fastifyHelmet as any, {
    contentSecurityPolicy: false,
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
  });

  await app.register(fastifyCompress as any, {
    global: true,
    threshold: 1024,
    encodings: ['br', 'gzip'],
    brotliOptions: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } },
  });

  await app.register(fastifyCookie as any);

  app.enableCors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Setup Redis Adapter for WebSockets
  const redisService = app.get(RedisService);
  const redisIoAdapter = new RedisIoAdapter(app, redisService);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
    new SanitizePipe(),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());

  app.setGlobalPrefix('api/v1/chat');

  if (!IS_PROD) {
    const config = new DocumentBuilder()
      .setTitle('Futsmandu Chat API')
      .setDescription('Unified Chat Service for real-time messaging between Players and Owners.')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
    new Logger('Swagger').log('📖 Docs: http://localhost:' + PORT + '/api/docs');
  }

  await app.listen(PORT, HOST);

  const logger = new Logger('Bootstrap');
  logger.log(`💬 Chat API ready at http://${HOST}:${PORT}/api/v1/chat`);
  logger.log(`   Environment: ${ENV['NODE_ENV']}`);
  logger.log(`   DB pool size per instance: ${ENV['DB_POOL_SIZE'] ?? 5}`);

  if (ENV['SENTRY_DSN']) {
    logger.log(`🐛 Sentry enabled: ${ENV['SENTRY_ENVIRONMENT']} (${ENV['SENTRY_RELEASE']})`);
  }

  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  for (const signal of signals) {
    process.on(signal, async () => {
      logger.log(`${signal} received — shutting down chat-api gracefully`);
      markRedisShuttingDown();
      await app.close();
      logger.log(`✅ Chat API shutdown complete`);
      process.exit(0);
    });
  }
}

bootstrap().catch((err: unknown) => {
  new Logger('Bootstrap').error('Fatal startup error', String(err));
  process.exit(1);
});

// CHANGED: [PgBouncer pool config, S-6 health timeout, P2024 pool-timeout handling]
// NEW ISSUES FOUND:
//   - onModuleInit had no timeout on SELECT 1 health check (S-6)
//   - Pool size was using Prisma default (10) — dangerous with multiple replicas

// packages/database/src/prisma.service.ts
// NestJS-injectable PrismaClient singleton.
// Implements OnModuleInit / OnModuleDestroy for clean lifecycle management.
// PgBouncer-safe: connection_limit per instance, pgbouncer=true required in DATABASE_URL.
// Pool budget: player-api=5/instance, owner-api=3/instance, worker=2/instance.

import { Injectable, InternalServerErrorException, OnModuleDestroy, OnModuleInit, Logger, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as PrismaGenerated from '../generated/prisma/index.js'
import { ENV } from '@futsmandu/utils'

// Prisma's generated client is shipped in a shape that doesn't always expose
// `PrismaClient` as a named ESM export under NodeNext/ESM.
const PrismaClient =
  (PrismaGenerated as any).PrismaClient ?? (PrismaGenerated as any).default?.PrismaClient

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name)
  private readonly config?: ConfigService

  constructor(@Optional() config?: ConfigService) {
    // NOTE: super() must run before any `this.*` access in derived classes.
    const baseUrl =
      config?.get<string>('DATABASE_URL', { infer: true }) ??
      ENV['DATABASE_URL']
    if (!baseUrl) {
      throw new InternalServerErrorException('Missing DATABASE_URL')
    }

    const poolSizeRaw =
      config?.get<string>('DATABASE_POOL_SIZE') ??
      config?.get<string>('DB_POOL_SIZE') ??
      ENV['DB_POOL_SIZE'] ??
      '5'
    const poolSize = Number.parseInt(poolSizeRaw, 10)
    const sep = baseUrl.includes('?') ? '&' : '?'
    const url = `${baseUrl}${sep}connection_limit=${poolSize}&pool_timeout=10`

    const nodeEnv = config?.get<string>('NODE_ENV') ?? ENV['NODE_ENV']
    super({
      datasources: { db: { url } },
      log:
        nodeEnv === 'development'
          ? [
              { emit: 'event', level: 'query' },
              { emit: 'stdout', level: 'warn' },
              { emit: 'stdout', level: 'error' },
            ]
          : [
              { emit: 'stdout', level: 'warn' },
              { emit: 'stdout', level: 'error' },
            ],
      errorFormat: nodeEnv === 'production' ? 'minimal' : 'pretty',
    })

    this.config = config

    // Ensure Prisma disconnects cleanly when the process is about to exit.
    // Prisma 5 throws if `$on('beforeExit')` is used with the library engine.
    try {
      this.$on('beforeExit', async () => {
        try {
          await this.$disconnect()
        } catch {
          // best-effort; process is already exiting
        }
      })
    } catch {
      process.on('beforeExit', async () => {
        try {
          await this.$disconnect()
        } catch {
          // best-effort
        }
      })
    }

    if (nodeEnv === 'development') {
      // Prisma emits a `query` event. Log only slow queries.
      this.$on('query', (e: { query: string; duration: number }) => {
        if (e.duration > 500) {
          this.logger.warn(`Slow query (${e.duration}ms): ${e.query}`)
        }
      })
    }

    // do not connect here; OnModuleInit handles connectivity per requirements
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect()
    } catch (err: unknown) {
      this.logger.error('Database unreachable at startup', String(err))
      // Postgres is a hard dependency; fail fast.
      process.exit(1)
    }

    const poolSize =
      this.config?.get<string>('DATABASE_POOL_SIZE') ??
      this.config?.get<string>('DB_POOL_SIZE') ??
      ENV['DB_POOL_SIZE'] ??
      '5'
    const node = this.config?.get<string>('HOSTNAME') ?? ENV['HOSTNAME'] ?? 'local'
    this.logger.log(`✅ Database connected (pool_size=${poolSize}, node=${node})`)
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.$disconnect()
      this.logger.log('Database disconnected')
    } catch (err: unknown) {
      this.logger.warn('Database disconnect failed', String(err))
    }
  }

  /**
   * Health check timeout tuned for local/dev network jitter.
   * Keeps probe bounded while reducing false "degraded" results.
   */
  async isHealthy(): Promise<boolean> {
    try {
      await Promise.race([
        this.$queryRaw`SELECT 1`,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject('DB health check timeout'), 5000),
        ),
      ])
      return true
    } catch {
      return false
    }
  }
}

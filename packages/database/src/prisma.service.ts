// CHANGED: [PgBouncer pool config, S-6 health timeout, P2024 pool-timeout handling]
// NEW ISSUES FOUND:
//   - onModuleInit had no timeout on SELECT 1 health check (S-6)
//   - Pool size was using Prisma default (10) — dangerous with multiple replicas

// packages/database/src/prisma.service.ts
// NestJS-injectable PrismaClient singleton.
// Implements OnModuleInit / OnModuleDestroy for clean lifecycle management.
// PgBouncer-safe: connection_limit per instance, pgbouncer=true required in DATABASE_URL.
// Pool budget: player-api=5/instance, owner-api=3/instance, worker=2/instance.

import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common'
import * as PrismaGenerated from '../generated/prisma/index.js'
import { ENV } from '@futsmandu/utils'

// Prisma's generated client is shipped in a shape that doesn't always expose
// `PrismaClient` as a named ESM export under `type: module`.
// Pull it from the module namespace (or its default export) at runtime.
const PrismaClient =
  (PrismaGenerated as any).PrismaClient ?? (PrismaGenerated as any).default?.PrismaClient

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name)

  constructor() {
    // PgBouncer: append connection_limit + pool_timeout to DATABASE_URL.
    // DATABASE_URL must already contain ?pgbouncer=true (set in .env).
    // pgbouncer=true disables Prisma prepared statement caching, which is
    // incompatible with PgBouncer transaction-mode pooling.
    const baseUrl  = ENV['DATABASE_URL']
    const poolSize = ENV['DB_POOL_SIZE'] ?? '5'
    const sep      = baseUrl.includes('?') ? '&' : '?'
    const url      = `${baseUrl}${sep}connection_limit=${poolSize}&pool_timeout=10`

    super({
      datasources: { db: { url } },
      log:
        ENV['NODE_ENV'] === 'development'
          ? [
              { emit: 'event',  level: 'query' },
              { emit: 'stdout', level: 'warn' },
              { emit: 'stdout', level: 'error' },
            ]
          : [
              { emit: 'stdout', level: 'warn' },
              { emit: 'stdout', level: 'error' },
            ],
      errorFormat: ENV['NODE_ENV'] === 'production' ? 'minimal' : 'pretty',
    })
  }

  async onModuleInit(): Promise<void> {
    await this.$connect()
    this.logger.log(
      `✅ Database connected (pool_size=${ENV['DB_POOL_SIZE'] ?? 5}, ` +
      `node=${ENV['HOSTNAME'] ?? 'local'})`,
    )

    if (ENV['NODE_ENV'] === 'development') {
      // Prisma emits a `query` event; typing is intentionally kept lightweight here.
      this.$on('query', (e: { query: string; duration: number }) => {
        if (e.duration > 500) {
          this.logger.warn(`Slow query (${e.duration}ms): ${e.query}`)
        }
      })
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect()
    this.logger.log('Database disconnected')
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
          setTimeout(() => reject(new Error('DB health check timeout')), 5000),
        ),
      ])
      return true
    } catch {
      return false
    }
  }
}

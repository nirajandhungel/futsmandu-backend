import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as PrismaGenerated from '../generated/prisma/index.js'
import { ENV } from '@futsmandu/utils'

// Resolve PrismaClient safely for ESM/CJS interop
const PrismaClient =
  (PrismaGenerated as any).PrismaClient ??
  (PrismaGenerated as any).default?.PrismaClient

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name)
  private isConnected = false

  constructor(private readonly config: ConfigService) {
    const databaseUrl =
      config.get<string>('DATABASE_URL') ?? ENV['DATABASE_URL']

    if (!databaseUrl) {
      throw new Error('DATABASE_URL is missing')
    }

    const nodeEnv = config.get<string>('NODE_ENV') ?? ENV['NODE_ENV']

    super({
      datasources: {
        db: {
          url: databaseUrl,
        },
      },

      // Keep logging minimal in production for performance
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

    // Log only slow queries (performance visibility without noise)
    if (nodeEnv === 'development') {
      this.$on('query', (e: { query: string; duration: number }) => {
        if (e.duration > 500) {
          this.logger.warn(
            `Slow Query (${e.duration}ms): ${e.query}`,
          )
        }
      })
    }
  }

  /**
   * Connect once on app bootstrap
   * Fail fast if DB is not reachable
   */
  async onModuleInit(): Promise<void> {
    const start = Date.now()

    try {
      await this.$connect()
      this.isConnected = true

      const duration = Date.now() - start
      this.logger.log(`✅ Prisma connected in ${duration}ms`)
    } catch (err) {
      this.logger.error('❌ Database connection failed', err as any)
      throw err
    }
  }

  /**
   * Clean shutdown (Fastify/Nest graceful stop)
   */
  async onModuleDestroy(): Promise<void> {
    try {
      await this.$disconnect()
      this.isConnected = false
      this.logger.log('🛑 Prisma disconnected cleanly')
    } catch (err) {
      this.logger.warn('⚠️ Prisma disconnect error', err as any)
    }
  }

  /**
   * Safe health check (NO leaks, NO runaway queries)
   */
  async isHealthy(): Promise<boolean> {
    if (!this.isConnected) return false

    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('DB health timeout')),
          3000,
        ),
      )

      await Promise.race([this.$queryRaw`SELECT 1`, timeout])

      return true
    } catch {
      return false
    }
  }

  /**
   * Optional: safe query wrapper for observability (use in critical services)
   */
  async safeQuery<T>(
    fn: () => Promise<T>,
    label = 'db-query',
  ): Promise<T> {
    const start = Date.now()

    try {
      const result = await fn()

      const duration = Date.now() - start
      if (duration > 300) {
        this.logger.warn(`⚠️ Slow ${label}: ${duration}ms`)
      }

      return result
    } catch (err) {
      this.logger.error(`❌ Failed ${label}`, err as any)
      throw err
    }
  }
}
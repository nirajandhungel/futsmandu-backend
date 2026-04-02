// packages/redis/src/redis.service.ts
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as IORedis from 'ioredis'

type RedisInstance = IORedis.default
type RedisCtor = new (url: string, opts: IORedis.RedisOptions) => RedisInstance

function resolveRedisCtor(): RedisCtor {
  const maybeDefault = (IORedis as unknown as { default?: RedisCtor }).default
  if (maybeDefault) return maybeDefault
  return IORedis as unknown as RedisCtor
}

function retryStrategy() {
  // ioredis passes "times" as the number of retries already attempted.
  // Stop after 10 retries, exponential backoff, capped at 3 seconds.
  return (times: number): number | null => {
    if (times > 10) return null
    return Math.min(3000, Math.pow(2, times - 1) * 100)
  }
}

function baseOpts(redisUrl: string): IORedis.RedisOptions {
  return {
    connectTimeout: 10_000,
    keepAlive: 30_000,
    retryStrategy: retryStrategy(),
    reconnectOnError: (err: Error) =>
      ['ETIMEDOUT', 'EPIPE', 'ECONNRESET', 'READONLY'].some(code =>
        err.message?.includes(code),
      ),
    tls: /^rediss:\/\//i.test(redisUrl) ? { rejectUnauthorized: false } : undefined,
  }
}

function cacheOpts(redisUrl: string): IORedis.RedisOptions {
  return {
    ...baseOpts(redisUrl),
    commandTimeout: 5_000,
    enableReadyCheck: true,
    // Cache is best-effort: don't retry commands aggressively; we swallow failures anyway.
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    lazyConnect: true,
  }
}

function bullOpts(redisUrl: string): IORedis.RedisOptions {
  return {
    ...baseOpts(redisUrl),
    // BullMQ relies on blocking commands; commandTimeout would break those.
    commandTimeout: undefined,
    enableReadyCheck: false,
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    lazyConnect: true,
  }
}

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name)
  private lastErrorLogAtMs = 0
  private errorStreak = 0

  /** General-purpose KV cache client (best-effort) */
  readonly client: RedisInstance

  /** Dedicated connection for BullMQ workers */
  readonly bullClient: RedisInstance

  readonly keys = {
    slotHold: (courtId: string, date: string, time: string) => `hold:${courtId}:${date}:${time}`,
    ban: (userId: string) => `ban:${userId}`,
    playerCtx: (playerId: string) => `player:ctx:${playerId}`,
    tonightFeed: (lat: number, lng: number, hour: string) =>
      `discovery:tonight:${Math.round(lat * 100)}:${Math.round(lng * 100)}:${hour}`,
    tomorrowFeed: (lat: number, lng: number, date: string) =>
      `discovery:tomorrow:${Math.round(lat * 100)}:${Math.round(lng * 100)}:${date}`,
    weekendFeed: (lat: number, lng: number, date: string) =>
      `discovery:weekend:${Math.round(lat * 100)}:${Math.round(lng * 100)}:${date}`,
    venueKpis: (venueId: string) => `venue:${venueId}:kpis`,
  } as const

  constructor(private readonly config: ConfigService) {
    const redisUrl =
      this.config.get<string>('REDIS_URL') ?? this.config.get<string>('UPSTASH_REDIS_IOREDIS_URL')
    if (!redisUrl) {
      throw new Error('Missing REDIS_URL (preferred) or UPSTASH_REDIS_IOREDIS_URL')
    }

    const RedisCtor = resolveRedisCtor()
    this.client = new RedisCtor(redisUrl, cacheOpts(redisUrl))
    this.bullClient = new RedisCtor(redisUrl, bullOpts(redisUrl))

    // Bind listeners immediately after creation so connection failures
    // never crash the process due to an unhandled 'error' event.
    this.bindClientEvents(this.client, 'cache')
    this.bindClientEvents(this.bullClient, 'bullmq')
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([
      this.client.quit().catch(() => undefined),
      this.bullClient.quit().catch(() => undefined),
    ])
  }

  private bindClientEvents(client: RedisInstance, label: 'cache' | 'bullmq'): void {
    client.on('connect', () => {
      this.errorStreak = 0
      this.lastErrorLogAtMs = 0
      this.logger.log(`Redis ${label} connected`)
    })

    client.on('close', () => {
      this.logger.warn(`Redis ${label} connection closed`)
    })

    client.on('error', (err: unknown) => {
      this.errorStreak++
      const now = Date.now()
      const shouldLog = this.errorStreak === 1 || now - this.lastErrorLogAtMs > 30_000
      if (!shouldLog) return
      this.lastErrorLogAtMs = now
      this.logger.error(`Redis ${label} error`, String(err))
    })
  }

  isConnected(): boolean {
    return this.client.status === 'ready'
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const val = await this.client.get(key)
      if (val === null) return null
      return val as unknown as T
    } catch (err: unknown) {
      const now = Date.now()
      if (now - this.lastErrorLogAtMs > 10_000) {
        this.lastErrorLogAtMs = now
        this.logger.warn('Redis cache get failed', String(err))
      }
      return null
    }
  }

  async set(key: string, value: unknown, exSeconds?: number): Promise<void> {
    try {
      const payload = typeof value === 'string' ? value : JSON.stringify(value)
      if (typeof exSeconds === 'number') {
        await this.client.set(key, payload, 'EX', exSeconds)
      } else {
        await this.client.set(key, payload)
      }
    } catch (err: unknown) {
      const now = Date.now()
      if (now - this.lastErrorLogAtMs > 10_000) {
        this.lastErrorLogAtMs = now
        this.logger.warn('Redis cache set failed', String(err))
      }
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key)
    } catch (err: unknown) {
      const now = Date.now()
      if (now - this.lastErrorLogAtMs > 10_000) {
        this.lastErrorLogAtMs = now
        this.logger.warn('Redis cache del failed', String(err))
      }
    }
  }

  async mget<T>(...keys: string[]): Promise<(T | null)[]> {
    if (keys.length === 0) return []
    try {
      const result = await this.client.mget(...keys)
      return result.map(v => (v === null ? null : (v as unknown as T)))
    } catch (err: unknown) {
      const now = Date.now()
      if (now - this.lastErrorLogAtMs > 10_000) {
        this.lastErrorLogAtMs = now
        this.logger.warn('Redis cache mget failed', String(err))
      }
      return keys.map(() => null)
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.ping()
      return true
    } catch {
      return false
    }
  }
}
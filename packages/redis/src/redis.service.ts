// packages/redis/src/redis.service.ts
//
// CHANGES vs previous version:
//   [M-1] Removed double-retry: ioredis already retries internally via retryStrategy.
//         withRetry() now only wraps truly transient app-level errors (not connection errors).
//   [M-2] Separated client concerns: `client` (cache/KV) vs `bullClient` (BullMQ).
//         BullMQ requires enableOfflineQueue:false + maxRetriesPerRequest:null.
//         Cache client uses enableOfflineQueue:true so commands queue during brief reconnects.
//   [M-3] Circuit breaker: after CIRCUIT_OPEN_THRESHOLD consecutive failures the breaker
//         opens and fast-fails for CIRCUIT_RESET_MS before allowing retries again.
//         This stops log spam and wasted resources on sustained Redis outages.
//   [M-4] waitForReady(): workers call this before starting BullMQ processors to ensure
//         Redis is reachable. Throws after MAX_READY_WAIT_MS if Redis never comes up.
//   [M-5] Fixed .d.ts mismatch: client is IORedis (not UpstashRedis). Regenerate dist/.

import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common'
import * as IORedis from 'ioredis'
import { ENV } from '@futsmandu/utils'

// ── Circuit Breaker Config ────────────────────────────────────────────────────
const CIRCUIT_OPEN_THRESHOLD = 5       // consecutive failures before opening
const CIRCUIT_RESET_MS       = 15_000  // how long to stay open before half-open probe
const MAX_READY_WAIT_MS      = 30_000  // waitForReady() gives up after this

// ── Simple in-process circuit breaker ────────────────────────────────────────
class CircuitBreaker {
  private failures  = 0
  private openSince = 0

  isOpen(): boolean {
    if (this.failures < CIRCUIT_OPEN_THRESHOLD) return false
    if (Date.now() - this.openSince > CIRCUIT_RESET_MS) {
      // half-open: allow one probe through
      this.failures = CIRCUIT_OPEN_THRESHOLD - 1
      return false
    }
    return true
  }

  recordSuccess(): void {
    this.failures  = 0
    this.openSince = 0
  }

  recordFailure(): void {
    this.failures++
    if (this.failures === CIRCUIT_OPEN_THRESHOLD) {
      this.openSince = Date.now()
    }
  }
}

// ── IORedis constructor normalisation (handles CJS/ESM dual-mode) ─────────────
function resolveRedisCtor(): new (url: string, opts: IORedis.RedisOptions) => IORedis.default {
  return (IORedis as any).default ?? (IORedis as any)
}

// ── Shared base options ───────────────────────────────────────────────────────
function baseOpts(redisUrl: string): IORedis.RedisOptions {
  return {
    connectTimeout:     10_000,
    keepAlive:          30_000,
    retryStrategy: (times: number) => {
      if (times > 10) return null           // stop retrying after 10 attempts — ioredis emits 'error'
      return Math.min(times * 200, 5_000)   // 200 → 400 → … → 5000ms cap
    },
    reconnectOnError: (err: Error) =>
      ['ETIMEDOUT', 'EPIPE', 'ECONNRESET', 'READONLY'].some(code =>
        err.message?.includes(code),
      ),
    tls: /^rediss:\/\//i.test(redisUrl) ? { rejectUnauthorized: false } : undefined,
  }
}

// ── Cache client options (used for get/set/del/mget) ─────────────────────────
function cacheOpts(redisUrl: string): IORedis.RedisOptions {
  return {
    ...baseOpts(redisUrl),
    commandTimeout:     5_000,
    enableReadyCheck:    true,
    maxRetriesPerRequest: 3,      // let ioredis retry commands on reconnect
    enableOfflineQueue:  true,    // queue commands during brief reconnects
    lazyConnect:         false,
  }
}

// ── BullMQ client options (strict — BullMQ manages its own retries) ───────────
function bullOpts(redisUrl: string): IORedis.RedisOptions {
  return {
    ...baseOpts(redisUrl),
    // BullMQ relies on blocking commands; commandTimeout would break those.
    commandTimeout:     undefined,
    enableReadyCheck:    false,   // BullMQ requirement
    maxRetriesPerRequest: null,   // BullMQ requirement
    enableOfflineQueue:  false,   // BullMQ requirement — fail fast, BullMQ handles it
    lazyConnect:         false,
  }
}

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger  = new Logger(RedisService.name)
  private readonly breaker = new CircuitBreaker()

  /** General-purpose KV cache client — safe for get/set/del/mget */
  readonly client: IORedis.default

  /** Dedicated connection for BullMQ workers — do NOT use for ad-hoc commands */
  readonly bullClient: IORedis.default

  constructor() {
    const redisUrl = ENV['REDIS_URL'] ?? ENV['UPSTASH_REDIS_IOREDIS_URL']
    if (!redisUrl) {
      throw new Error('Missing REDIS_URL (preferred) or UPSTASH_REDIS_IOREDIS_URL')
    }

    const RedisCtor = resolveRedisCtor()

    this.client     = new RedisCtor(redisUrl, cacheOpts(redisUrl))
    this.bullClient = new RedisCtor(redisUrl, bullOpts(redisUrl))

    this.client.on('connect', () => {
      this.logger.log('✅ Cache Redis connected')
      this.breaker.recordSuccess()
    })
    this.client.on('error', (err: unknown) => {
      this.logger.error('Cache Redis error', String(err))
      this.breaker.recordFailure()
    })

    this.bullClient.on('connect', () => this.logger.log('✅ BullMQ Redis connected'))
    this.bullClient.on('error',   (err: unknown) => this.logger.error('BullMQ Redis error', String(err)))
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.client.quit(), this.bullClient.quit()])
  }

  // ── Health Gate ───────────────────────────────────────────────────────────

  /**
   * Call from your worker `onModuleInit()` before registering BullMQ processors.
   * Polls until Redis responds to PING or MAX_READY_WAIT_MS is exceeded.
   *
   * @example
   *   async onModuleInit() {
   *     await this.redisService.waitForReady()
   *     this.worker.run()
   *   }
   */
  async waitForReady(): Promise<void> {
    const deadline = Date.now() + MAX_READY_WAIT_MS
    let attempt    = 0

    while (Date.now() < deadline) {
      try {
        await this.client.ping()
        this.logger.log('✅ Redis health-check passed')
        return
      } catch (err) {
        attempt++
        const wait = Math.min(attempt * 500, 5_000)
        this.logger.warn(`Redis not ready (attempt ${attempt}), retrying in ${wait}ms: ${String(err)}`)
        await new Promise(r => setTimeout(r, wait))
      }
    }

    throw new Error(`Redis not ready after ${MAX_READY_WAIT_MS}ms — aborting worker startup`)
  }

  // ── Key Builders ──────────────────────────────────────────────────────────

  readonly keys = {
    slotHold:    (courtId: string, date: string, time: string) => `hold:${courtId}:${date}:${time}`,
    ban:         (userId: string)                               => `ban:${userId}`,
    playerCtx:   (playerId: string)                            => `player:ctx:${playerId}`,
    tonightFeed: (lat: number, lng: number, hour: string)       => `discovery:tonight:${Math.round(lat * 100)}:${Math.round(lng * 100)}:${hour}`,
    tomorrowFeed:(lat: number, lng: number, date: string)       => `discovery:tomorrow:${Math.round(lat * 100)}:${Math.round(lng * 100)}:${date}`,
    weekendFeed: (lat: number, lng: number, date: string)       => `discovery:weekend:${Math.round(lat * 100)}:${Math.round(lng * 100)}:${date}`,
    venueKpis:   (venueId: string)                              => `venue:${venueId}:kpis`,
  } as const

  // ── KV Helpers ────────────────────────────────────────────────────────────
  // Note: ioredis handles retries internally via retryStrategy + maxRetriesPerRequest.
  // We add a circuit-breaker guard here to fast-fail during sustained outages.

  private guardBreaker(op: string): void {
    if (this.breaker.isOpen()) {
      throw new Error(`Redis circuit open — skipping ${op}`)
    }
  }

  async get<T>(key: string): Promise<T | null> {
    this.guardBreaker(`get(${key})`)
    try {
      const val = await this.client.get(key)
      this.breaker.recordSuccess()
      return val as T | null
    } catch (err) {
      this.breaker.recordFailure()
      this.logger.error(`Redis get(${key}) failed`, String(err))
      throw err
    }
  }

  async set(key: string, value: unknown, exSeconds?: number): Promise<void> {
    this.guardBreaker(`set(${key})`)
    try {
      if (exSeconds) {
        await this.client.set(key, String(value), 'EX', exSeconds)
      } else {
        await this.client.set(key, String(value))
      }
      this.breaker.recordSuccess()
    } catch (err) {
      this.breaker.recordFailure()
      this.logger.error(`Redis set(${key}) failed`, String(err))
      throw err
    }
  }

  async del(key: string): Promise<void> {
    this.guardBreaker(`del(${key})`)
    try {
      await this.client.del(key)
      this.breaker.recordSuccess()
    } catch (err) {
      this.breaker.recordFailure()
      this.logger.error(`Redis del(${key}) failed`, String(err))
      throw err
    }
  }

  async mget<T>(...keys: string[]): Promise<(T | null)[]> {
    if (keys.length === 0) return []
    this.guardBreaker(`mget(${keys.length} keys)`)
    try {
      const result = await this.client.mget(...keys) as (T | null)[]
      this.breaker.recordSuccess()
      return result
    } catch (err) {
      this.breaker.recordFailure()
      this.logger.error(`Redis mget(${keys.length} keys) failed`, String(err))
      throw err
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.ping()
      this.breaker.recordSuccess()
      return true
    } catch {
      this.breaker.recordFailure()
      return false
    }
  }
}
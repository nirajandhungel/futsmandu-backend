// packages/redis/src/redis.service.ts
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import * as IORedis from 'ioredis'
import { ENV } from '@futsmandu/utils'

type RedisInstance = IORedis.default
type RedisCtor = new (url: string, opts: IORedis.RedisOptions) => RedisInstance

let isRedisShuttingDown = false

export function markRedisShuttingDown(): void {
  isRedisShuttingDown = true
}

export function isRedisShuttingDownFunc(): boolean {
  return isRedisShuttingDown
}

// ─────────────────────────────────────────────────────────────────────────────
// ESM / CJS compat shim
// ─────────────────────────────────────────────────────────────────────────────
function resolveRedisCtor(): RedisCtor {
  const maybeDefault = (IORedis as unknown as { default?: RedisCtor }).default
  if (maybeDefault) return maybeDefault
  return IORedis as unknown as RedisCtor
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry strategy
//
// Design rationale:
//   - Upstash is a managed cloud service; most outages are 5–60 s blips, not
//     permanent failures.  Giving up after 10 retries (~3 s total) left BullMQ
//     with a permanently dead socket and caused the original error cascade.
//   - We retry for up to ~5 minutes (30 attempts).  After that ioredis fires
//     the 'end' event which we log as a fatal signal.  If the process is
//     supervised (systemd, Render, Docker) it will be restarted — which is the
//     correct action for a truly dead Redis connection.
//   - Exponential back-off capped at 15 s prevents hammering Upstash's command
//     quota during a sustained outage (the 37 K commands / 2 min problem).
//
// keepAlive tuning:
//   Upstash closes idle TCP sockets after ~55 s.  A keepAlive probe every 25 s
//   keeps the socket alive without excessive syscall churn.  25 s is the sweet
//   spot for Upstash; lower (15 s) causes more churn, higher (30 s+) risks
//   occasional silent socket death before the probe fires.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_RETRY_ATTEMPTS = 30

function retryStrategy(times: number): number | null {
  if (isRedisShuttingDown) {
    return null
  }

  if (times > MAX_RETRY_ATTEMPTS) {
    // Returning null tells ioredis to stop retrying and emit 'end'.
    // The 'end' listener below logs a fatal error.  In production the
    // process supervisor (Render / systemd / Docker) will restart.
    return null
  }
  // 100 ms, 200 ms, 400 ms … capped at 15 s
  return Math.min(15_000, Math.pow(2, Math.min(times - 1, 7)) * 100)
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection option factories
// ─────────────────────────────────────────────────────────────────────────────
function baseOpts(redisUrl: string): IORedis.RedisOptions {
  return {
    connectTimeout: 10_000,
    keepAlive: 25_000,
    retryStrategy,
    reconnectOnError: (err: Error) =>
      ['ETIMEDOUT', 'EPIPE', 'ECONNRESET', 'READONLY'].some(code =>
        err.message?.includes(code),
      ),
    // TLS is mandatory for Upstash (rediss://).  rejectUnauthorized: false is
    // safe here because Upstash uses a self-signed cert on the ioredis endpoint.
    tls: /^rediss:\/\//i.test(redisUrl) ? { rejectUnauthorized: false } : undefined,
  }
}

function cacheOpts(redisUrl: string): IORedis.RedisOptions {
  return {
    ...baseOpts(redisUrl),
    commandTimeout: 5_000,
    enableReadyCheck: true,
    // Cache is best-effort.  Fail fast (0 retries) so callers return a cache
    // miss immediately instead of blocking the HTTP response thread.
    maxRetriesPerRequest: 0,
    // enableOfflineQueue: false — commands during reconnect throw immediately;
    // we catch them and return null (acceptable for a cache).
    enableOfflineQueue: false,
    lazyConnect: true,
  }
}

function bullOpts(redisUrl: string): IORedis.RedisOptions {
  return {
    ...baseOpts(redisUrl),
    // commandTimeout MUST be undefined for BullMQ.
    // BullMQ uses BZPOPMIN which is a blocking pop — it intentionally waits
    // forever for a new job.  A command timeout would cancel that wait.
    commandTimeout: undefined,
    // enableReadyCheck: false — BullMQ handles its own readiness; the
    // extra PING round-trip from the ready check is wasted overhead.
    enableReadyCheck: false,
    // maxRetriesPerRequest: null — BullMQ requires this exact value.
    // It means "retry forever until the connection is re-established",
    // which is what allows BullMQ to survive a transient Redis outage.
    maxRetriesPerRequest: null,
    // ── enableOfflineQueue: true — THE CRITICAL FIX ──────────────────────
    //
    // Root cause of "Stream isn't writeable and enableOfflineQueue is false":
    //
    //   1. ETIMEDOUT: Upstash dropped the TCP socket (idle timeout or blip).
    //   2. ioredis starts reconnecting (async).
    //   3. BullMQ immediately issues the next BZPOPMIN (blocking job poll).
    //   4. With false: command is rejected synchronously → BullMQ catches,
    //      retries in a tight loop → 37 K Redis commands in 2 min → Upstash
    //      rate-limit / command quota spike → connection stays broken → loop.
    //   5. With true: ioredis queues the BZPOPMIN internally and replays it
    //      the moment the socket is restored — exactly what BullMQ expects.
    //
    // This single flag change eliminates the cascade.
    enableOfflineQueue: true,
    lazyConnect: true,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-client log-throttle state
// ─────────────────────────────────────────────────────────────────────────────
interface ThrottleState {
  streak: number   // consecutive errors since last successful connect
  lastLogAt: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Circuit breaker (cache client only)
//
// The cache circuit breaker short-circuits get/set/del/mget when Redis is
// confirmed unreachable, so the API does not spend 5 s per request waiting for
// commandTimeout to fire.  It does NOT apply to bullClient — BullMQ manages
// its own retry loop and must never be short-circuited externally.
// ─────────────────────────────────────────────────────────────────────────────
interface BreakerState {
  open: boolean
  failures: number
  lastFailureAt: number
  halfOpenAt: number
}

// ─────────────────────────────────────────────────────────────────────────────
// RedisService
// ─────────────────────────────────────────────────────────────────────────────
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name)

  // Separate throttle state per client so cache noise never suppresses
  // BullMQ error logs (and vice-versa).
  private readonly throttle: Record<'cache' | 'bullmq', ThrottleState> = {
    cache:  { streak: 0, lastLogAt: 0 },
    bullmq: { streak: 0, lastLogAt: 0 },
  }

  // Enforce a singleton for process-local Redis handles, even if DI gets invoked
  // multiple times (defensive, prevents connection explosion in edge cases).
  private static shared?: {
    client: RedisInstance
    bullClient: RedisInstance
  }

  readonly breaker: BreakerState = {
    open: false,
    failures: 0,
    lastFailureAt: 0,
    halfOpenAt: 0,
  }

  // Open the cache breaker after 5 consecutive failures.
  // After 30 s in the open state allow one probe through (half-open).
  private static readonly BREAKER_THRESHOLD = 5
  private static readonly BREAKER_RESET_MS  = 30_000

  /** General-purpose KV cache client (best-effort) */
  readonly client: RedisInstance

  /**
   * Dedicated ioredis connection for BullMQ.
   * DO NOT use this for ad-hoc cache commands — BullMQ owns this socket.
   */
  readonly bullClient: RedisInstance

  private readonly readyLogged: Record<'cache' | 'bullmq', boolean> = {
    cache: false,
    bullmq: false,
  }

  readonly keys = {
    slotHold:    (courtId: string, date: string, time: string) =>
      `hold:${courtId}:${date}:${time}`,
    ban:         (userId: string)                               => `ban:${userId}`,
    playerCtx:   (playerId: string)                             => `player:ctx:${playerId}`,
    tonightFeed: (lat: number, lng: number, hour: string)       =>
      `discovery:tonight:${Math.round(lat * 100)}:${Math.round(lng * 100)}:${hour}`,
    tomorrowFeed:(lat: number, lng: number, date: string)       =>
      `discovery:tomorrow:${Math.round(lat * 100)}:${Math.round(lng * 100)}:${date}`,
    weekendFeed: (lat: number, lng: number, date: string)       =>
      `discovery:weekend:${Math.round(lat * 100)}:${Math.round(lng * 100)}:${date}`,
    venueKpis:   (venueId: string)                              => `venue:${venueId}:kpis`,
  } as const

  constructor() {
    // ENV.REDIS_URL is guaranteed non-null here because
    // validateENV() runs in each service's bootstrap() before NestJS
    // initialises any module — a missing URL causes process.exit(1) first.
    const redisUrl = ENV.REDIS_URL

    if (RedisService.shared) {
      this.client = RedisService.shared.client
      this.bullClient = RedisService.shared.bullClient
      return
    }

    const RedisCtor = resolveRedisCtor()
    const cacheClient = new RedisCtor(redisUrl, cacheOpts(redisUrl))
    const bullClient = cacheClient.duplicate(bullOpts(redisUrl))

    this.client = cacheClient
    this.bullClient = bullClient

    RedisService.shared = {
      client: cacheClient,
      bullClient,
    }

    // Bind listeners before returning from the constructor so that connection
    // failures on the very first connect attempt are always handled and never
    // crash the process with an unhandled 'error' event.
    this.bindClientEvents(this.client,     'cache')
    this.bindClientEvents(this.bullClient, 'bullmq')
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  async onModuleDestroy(): Promise<void> {
    if (!isRedisShuttingDown) {
      markRedisShuttingDown()
    }

    this.logger.log('Redis shutdown in progress — closing connections')
    await Promise.allSettled([
      this.client.quit().catch(() => undefined),
      this.bullClient.quit().catch(() => undefined),
    ])
  }

  // ───────────────────────────────────────────────────────────────────────────
  // waitForReady — call from worker onModuleInit() before BullMQ starts
  //
  // Workers must wait for Redis to be fully connected before BullMQ registers
  // its processors.  If BullMQ is handed a socket that is still performing the
  // TLS handshake it immediately issues commands, which were the original
  // ETIMEDOUT → "Stream isn't writeable" cascade trigger.
  //
  // Usage in any worker module:
  //
  //   @Injectable()
  //   export class MyWorker extends WorkerHost implements OnModuleInit {
  //     constructor(private readonly redis: RedisService) { super() }
  //
  //     async onModuleInit() {
  //       await this.redis.waitForReady()
  //     }
  //     ...
  //   }
  // ───────────────────────────────────────────────────────────────────────────
  async waitForReady(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let attempt = 0

    while (Date.now() < deadline) {
      attempt++
      try {
        // lazyConnect means ioredis hasn't dialled yet.  connect() triggers
        // the TLS handshake.  Subsequent calls while already connected are
        // no-ops.
        if (this.bullClient.status === 'wait') {
          await this.bullClient.connect()
        }
        await this.bullClient.ping()
        this.logger.log(`Redis ready after ${attempt} attempt(s)`)
        return
      } catch (err: unknown) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        // Back off linearly up to 2 s so startup probes are not expensive
        const delay = Math.min(2_000, attempt * 250)
        this.logger.warn(
          `Redis not ready (attempt ${attempt}): ${String(err)} — retrying in ${delay} ms`,
        )
        await new Promise(r => setTimeout(r, delay))
      }
    }

    // Do NOT throw.  Throwing kills the worker process even when Redis is
    // only briefly unavailable (rolling restart, cold-start latency, etc.).
    // The process supervisor will restart us if Redis stays down.
    this.logger.error(
      `Redis did not become ready within ${timeoutMs / 1_000} s. ` +
      'Workers starting anyway — jobs will queue until connection restores.',
    )
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Circuit-breaker helpers (cache only)
  // ───────────────────────────────────────────────────────────────────────────

  private isBreakerOpen(): boolean {
    if (!this.breaker.open) return false
    if (Date.now() >= this.breaker.halfOpenAt) {
      // Half-open: let one probe through to test if Redis recovered.
      this.breaker.open = false
      this.logger.log('Redis circuit breaker half-open — probing')
      return false
    }
    return true
  }

  private recordSuccess(): void {
    if (this.breaker.failures > 0) {
      this.breaker.failures = 0
      this.breaker.open = false
      this.logger.log('Redis circuit breaker closed (recovered)')
    }
  }

  private recordFailure(): void {
    this.breaker.failures++
    this.breaker.lastFailureAt = Date.now()
    if (
      !this.breaker.open &&
      this.breaker.failures >= RedisService.BREAKER_THRESHOLD
    ) {
      this.breaker.open = true
      this.breaker.halfOpenAt = Date.now() + RedisService.BREAKER_RESET_MS
      this.logger.error(
        `Redis circuit breaker OPEN after ${this.breaker.failures} failures. ` +
        `Cache returning null for ${RedisService.BREAKER_RESET_MS / 1_000} s.`,
      )
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Event binding
  // ───────────────────────────────────────────────────────────────────────────

  private bindClientEvents(
    client: RedisInstance,
    label: 'cache' | 'bullmq',
  ): void {
    const t = this.throttle[label]

    client.on('connect', () => {
      t.streak    = 0
      t.lastLogAt = 0
      if (label === 'cache') this.recordSuccess()
      this.logger.log(`Redis ${label} connected`)
    })

    client.on('ready', () => {
      if (this.readyLogged[label]) return
      this.readyLogged[label] = true
      this.logger.log(`Redis ${label} ready`)

      if (label === 'bullmq') {
        void this.ensureNoEvictionPolicy(client)
      }
    })

    client.on('reconnecting', (delay: number) => {
      this.logger.warn(`Redis ${label} reconnecting in ${delay} ms`)
    })

    client.on('close', () => {
      this.readyLogged[label] = false
      this.logger.warn(`Redis ${label} connection closed`)
    })

    client.on('end', () => {
      this.readyLogged[label] = false
      if (isRedisShuttingDown) {
        this.logger.log(`Redis ${label} connection ended during shutdown`) 
        return
      }
      // ioredis fires 'end' when retryStrategy returned null — i.e., we
      // exceeded MAX_RETRY_ATTEMPTS (~5 min).  Log fatally; the process
      // supervisor should restart us.
      this.logger.error(
        `Redis ${label} connection permanently ended after ${MAX_RETRY_ATTEMPTS} retries. ` +
        'The process should be restarted by the supervisor.',
      )
    })

    client.on('error', (err: unknown) => {
      t.streak++
      if (label === 'cache') this.recordFailure()

      const now = Date.now()
      // Always log the first error in a streak.  Then throttle to one log
      // every 30 s to avoid flooding the log stream during an outage.
      const shouldLog = t.streak === 1 || now - t.lastLogAt > 30_000
      if (!shouldLog) return
      t.lastLogAt = now
      this.logger.error(
        `Redis ${label} error (streak: ${t.streak})`,
        String(err),
      )
    })
  }

  private async ensureNoEvictionPolicy(client: RedisInstance): Promise<void> {
    try {
      const configPair = await client.config('GET', 'maxmemory-policy')
      const policy = Array.isArray(configPair) ? configPair[1] : undefined

      if (policy && policy !== 'noeviction') {
        this.logger.warn(
          `Redis maxmemory-policy is ${policy}. Setting to noeviction is recommended for queues.`,
        )
        try {
          await client.config('SET', 'maxmemory-policy', 'noeviction')
          this.logger.log('Redis maxmemory-policy switched to noeviction')
        } catch (setErr) {
          this.logger.warn(
            'Unable to set Redis maxmemory-policy to noeviction (may be managed host or read-only):',
            String(setErr),
          )
        }
      }
    } catch (err) {
      this.logger.warn(
        'Cannot read Redis maxmemory-policy:',
        String(err),
      )
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Public helpers
  // ───────────────────────────────────────────────────────────────────────────

  isConnected(): boolean {
    return this.client.status === 'ready'
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.ping()
      return true
    } catch {
      return false
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Cache CRUD — all best-effort; failures return null / are swallowed
  // ───────────────────────────────────────────────────────────────────────────

  async get<T>(key: string): Promise<T | null> {
    if (this.isBreakerOpen()) return null
    try {
      const val = await this.client.get(key)
      if (val !== null) this.recordSuccess()
      if (val === null) return null
      try { return JSON.parse(val) as T } catch { return val as unknown as T }
    } catch (err: unknown) {
      this.recordFailure()
      this.throttledWarn('cache', 'Redis cache get failed', err)
      return null
    }
  }

  async set(key: string, value: unknown, exSeconds?: number): Promise<void> {
    if (this.isBreakerOpen()) return
    try {
      const payload = typeof value === 'string' ? value : JSON.stringify(value)
      if (typeof exSeconds === 'number') {
        await this.client.set(key, payload, 'EX', exSeconds)
      } else {
        await this.client.set(key, payload)
      }
      this.recordSuccess()
    } catch (err: unknown) {
      this.recordFailure()
      this.throttledWarn('cache', 'Redis cache set failed', err)
    }
  }

  async del(key: string): Promise<void> {
    if (this.isBreakerOpen()) return
    try {
      await this.client.del(key)
      this.recordSuccess()
    } catch (err: unknown) {
      this.recordFailure()
      this.throttledWarn('cache', 'Redis cache del failed', err)
    }
  }

  async mget<T>(...keys: string[]): Promise<(T | null)[]> {
    if (keys.length === 0) return []
    if (this.isBreakerOpen()) return keys.map(() => null)
    try {
      const result = await this.client.mget(...keys)
      this.recordSuccess()
      return result.map(v => {
        if (v === null) return null
        try { return JSON.parse(v) as T } catch { return v as unknown as T }
      })
    } catch (err: unknown) {
      this.recordFailure()
      this.throttledWarn('cache', 'Redis cache mget failed', err)
      return keys.map(() => null)
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ───────────────────────────────────────────────────────────────────────────

  private throttledWarn(
    label: 'cache' | 'bullmq',
    msg: string,
    err: unknown,
    windowMs = 10_000,
  ): void {
    const t = this.throttle[label]
    const now = Date.now()
    if (now - t.lastLogAt < windowMs) return
    t.lastLogAt = now
    this.logger.warn(msg, String(err))
  }
}

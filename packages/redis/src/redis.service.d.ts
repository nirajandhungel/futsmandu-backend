import { OnModuleDestroy } from '@nestjs/common';
import IORedis from 'ioredis';

export declare class RedisService implements OnModuleDestroy {
  private readonly logger;
  private readonly throttle;

  /** Circuit-breaker state for the cache client (exposed for health checks). */
  readonly breaker: {
    open: boolean;
    failures: number;
    lastFailureAt: number;
    halfOpenAt: number;
  };

  /** General-purpose KV cache client (best-effort). */
  readonly client: IORedis;

  /**
   * Dedicated ioredis connection for BullMQ.
   * DO NOT use for ad-hoc cache commands — BullMQ owns this socket.
   */
  readonly bullClient: IORedis;

  constructor();

  onModuleDestroy(): Promise<void>;

  /**
   * Polls Redis with PING until it responds or `timeoutMs` ms elapse (default 30 s).
   *
   * Call from every worker's onModuleInit() before processors are registered:
   *
   * ```ts
   * async onModuleInit() {
   *   await this.redis.waitForReady()
   * }
   * ```
   *
   * Prevents BullMQ from issuing commands onto a socket that is still
   * completing its TLS handshake (the original cause of the error cascade).
   */
  waitForReady(timeoutMs?: number): Promise<void>;

  isConnected(): boolean;
  ping(): Promise<boolean>;

  readonly keys: {
    readonly slotHold:    (courtId: string, date: string, time: string) => string;
    readonly ban:         (userId: string)                               => string;
    readonly playerCtx:   (playerId: string)                             => string;
    readonly tonightFeed: (lat: number, lng: number, hour: string)       => string;
    readonly tomorrowFeed:(lat: number, lng: number, date: string)       => string;
    readonly weekendFeed: (lat: number, lng: number, date: string)       => string;
    readonly venueKpis:   (venueId: string)                              => string;
  };

  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, exSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  mget<T>(...keys: string[]): Promise<(T | null)[]>;
}
//# sourceMappingURL=redis.service.d.ts.map

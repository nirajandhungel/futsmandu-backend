import { OnModuleDestroy } from '@nestjs/common';
import IORedis from 'ioredis';

export declare class RedisService implements OnModuleDestroy {
  private readonly logger;
  private readonly breaker;

  /** General-purpose KV cache client */
  readonly client: IORedis;

  /** Dedicated BullMQ connection — do NOT use for ad-hoc commands */
  readonly bullClient: IORedis;

  constructor();

  onModuleDestroy(): Promise<void>;

  /**
   * Polls Redis until PING succeeds or 30 s elapses.
   * Call from worker onModuleInit() before registering BullMQ processors.
   */
  waitForReady(): Promise<void>;

  readonly keys: {
    readonly slotHold:    (courtId: string, date: string, time: string) => string;
    readonly ban:         (userId: string)                               => string;
    readonly playerCtx:   (playerId: string)                            => string;
    readonly tonightFeed: (lat: number, lng: number, hour: string)       => string;
    readonly tomorrowFeed:(lat: number, lng: number, date: string)       => string;
    readonly weekendFeed: (lat: number, lng: number, date: string)       => string;
    readonly venueKpis:   (venueId: string)                              => string;
  };

  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, exSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  mget<T>(...keys: string[]): Promise<(T | null)[]>;
  ping(): Promise<boolean>;
}
//# sourceMappingURL=redis.service.d.ts.map
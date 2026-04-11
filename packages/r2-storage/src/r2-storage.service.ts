/**
 * @futsmandu/r2-storage
 *
 * Shared Cloudflare R2 presigned URL service.
 * Provides getPresignedGetUrl, getPresignedPutUrl, deleteObject with in-memory caching.
 *
 * DOES NOT replace @futsmandu/media-storage.
 * Sits alongside it and adds the GET-presigning + caching layer that was missing.
 *
 * Used by:
 *   - @futsmandu/media  (MediaService.getSignedImageUrl)
 *   - admin-api         (KYC doc viewing, venue verification viewing)
 *   - owner-api         (KYC doc self-view, gallery viewing)
 *   - player-api        (venue cover / gallery / avatar viewing)
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createS3Client, type S3ClientOptions } from '@futsmandu/media-storage'
import type { S3Client } from '@aws-sdk/client-s3'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface R2StorageOptions {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  /** Feature flag: when false, cache is a no-op. Default: true */
  enableCache?: boolean
  /** Default GET URL expiry in seconds. Default: 3600 (1 hour) */
  defaultGetExpirySeconds?: number
}

export interface CachedUrl {
  url: string
  /** Epoch ms when this entry expires from cache */
  expiresAt: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** How long we cache a signed GET URL in memory (50 min — 10 min before R2 expiry) */
const CACHE_TTL_MS = 50 * 60 * 1_000

/** Default signed URL lifetime (1 hour) */
const DEFAULT_GET_EXPIRY_SECONDS = 3_600

/** Purge stale entries every 5 minutes (prevents unbounded Map growth) */
const CACHE_PURGE_INTERVAL_MS = 5 * 60 * 1_000

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class R2StorageService implements OnModuleDestroy {
  private readonly logger = new Logger(R2StorageService.name)
  private readonly s3: S3Client
  private readonly bucket: string
  private readonly enableCache: boolean
  private readonly defaultGetExpiry: number

  /**
   * In-memory LRU-lite cache: key → { url, expiresAt }
   *
   * We use a plain Map (insertion order) rather than a full LRU lib to keep
   * the dependency tree minimal.  The periodic purge in startCachePurge() is
   * sufficient for the expected cardinality (<10 K entries across all venues).
   *
   * If your fleet grows to thousands of concurrent nodes, replace this with
   * Redis (already available via @futsmandu/redis) by implementing a
   * RedisSignedUrlCache strategy behind the same interface.
   */
  private readonly cache = new Map<string, CachedUrl>()
  private purgeTimer?: ReturnType<typeof setInterval>

  constructor(opts: R2StorageOptions) {
    const s3Opts: S3ClientOptions = {
      endpoint:        opts.endpoint,
      region:          opts.region,
      accessKeyId:     opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      forcePathStyle:  false, // Cloudflare R2 does not use path-style
    }
    this.s3             = createS3Client(s3Opts)
    this.bucket         = opts.bucket
    this.enableCache    = opts.enableCache ?? true
    this.defaultGetExpiry = opts.defaultGetExpirySeconds ?? DEFAULT_GET_EXPIRY_SECONDS

    if (this.enableCache) {
      this.startCachePurge()
    }
  }

  onModuleDestroy(): void {
    if (this.purgeTimer) clearInterval(this.purgeTimer)
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Generate (or return cached) a presigned GET URL for any R2 object.
   *
   * Works for both public and private assets.  Call this instead of returning
   * raw R2 URLs so that:
   *   - Private assets (KYC, venue verification) remain access-controlled
   *   - Public assets (avatars, venue covers) don't expose your R2 endpoint
   *
   * @param key       R2 object key, e.g. "venues/abc/cover/xyz.jpg"
   * @param expiresIn Seconds until the URL expires. Defaults to 3600.
   */
  async getPresignedGetUrl(key: string, expiresIn?: number): Promise<string> {
    const ttlSeconds = expiresIn ?? this.defaultGetExpiry
    const cacheKey   = this.buildCacheKey(key, ttlSeconds)

    // Cache hit
    if (this.enableCache) {
      const cached = this.cache.get(cacheKey)
      if (cached && cached.expiresAt > Date.now()) {
        return cached.url
      }
    }

    // Cache miss — generate
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key })
    const url = await getSignedUrl(this.s3, cmd, { expiresIn: ttlSeconds })

    if (this.enableCache) {
      this.cache.set(cacheKey, {
        url,
        expiresAt: Date.now() + CACHE_TTL_MS,
      })
    }

    this.logger.debug(`Presigned GET URL generated for key: ${key}`)
    return url
  }

  /**
   * Generate a presigned PUT URL for uploading an object.
   * This is a thin wrapper over @futsmandu/media-storage's generateSignedUploadUrl
   * kept here so callers can use a single service for all R2 operations.
   */
  async getPresignedPutUrl(
    key: string,
    contentType: string,
    expiresIn = 600,
  ): Promise<string> {
    const cmd = new PutObjectCommand({
      Bucket:      this.bucket,
      Key:         key,
      ContentType: contentType,
    })
    return getSignedUrl(this.s3, cmd, { expiresIn })
  }

  /**
   * Delete an object from R2.  Also evicts all cached GET URLs for this key.
   */
  async deleteObject(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
    this.evictKey(key)
    this.logger.log(`Deleted R2 object: ${key}`)
  }

  /**
   * Manually evict a specific key from the cache (call after upload confirmation
   * if you want to force a fresh URL on next access).
   */
  evictCacheForKey(key: string): void {
    this.evictKey(key)
  }

  /**
   * Returns the number of entries currently in the cache.
   * Useful for health/debug endpoints.
   */
  get cacheSize(): number {
    return this.cache.size
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private buildCacheKey(key: string, ttlSeconds: number): string {
    // Include ttlSeconds in cache key so that requests for 10-min vs 1-hour
    // URLs for the same object get distinct cache entries.
    return `${ttlSeconds}:${key}`
  }

  private evictKey(key: string): void {
    // Evict all cache entries for this key regardless of ttl bucket
    for (const cacheKey of this.cache.keys()) {
      if (cacheKey.endsWith(`:${key}`)) {
        this.cache.delete(cacheKey)
      }
    }
  }

  private startCachePurge(): void {
    this.purgeTimer = setInterval(() => {
      const now     = Date.now()
      let evicted   = 0
      for (const [k, v] of this.cache.entries()) {
        if (v.expiresAt <= now) {
          this.cache.delete(k)
          evicted++
        }
      }
      if (evicted > 0) {
        this.logger.debug(`Cache purge: evicted ${evicted} stale signed-URL entries`)
      }
    }, CACHE_PURGE_INTERVAL_MS)

    // Prevent the timer from blocking process exit
    if (this.purgeTimer.unref) this.purgeTimer.unref()
  }
}

// packages/media-storage/src/storage.service.ts
//
// Pure utility class — NO NestJS decorators here.
// media-storage has no NestJS dependency.
// The NestJS @Injectable wrapper + StorageModule live in packages/media/.
//
// Used directly by:
//   - packages/media  (via StorageModule which wraps this)
//   - packages/media-processing (injects S3Client directly for streaming)

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StorageConfig {
  endpoint:        string
  region:          string
  accessKeyId:     string
  secretAccessKey: string
  bucket:          string
  /** Cache presigned GET URLs in memory. Default: true */
  enableCache?:    boolean
  /** Default expiry for presigned GET URLs in seconds. Default: 3600 */
  defaultGetExpirySeconds?: number
  /** Force path-style URLs. False for R2/CloudFront, true for local MinIO. */
  forcePathStyle?: boolean
}

export interface SignedUploadOptions {
  key:          string
  contentType:  string
  cacheControl: string
  expiresIn?:   number  // default 600
}

export interface StorageObjectMetadata {
  contentType?:   string
  contentLength?: number
  lastModified?:  Date
}

// ─── Internal cache entry ─────────────────────────────────────────────────────

interface CachedUrl {
  url:       string
  expiresAt: number  // epoch ms
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Cache signed GET URLs for 50 min — 10 min buffer before R2's 1h expiry. */
const CACHE_TTL_MS            = 50 * 60 * 1_000
const DEFAULT_GET_EXPIRY_S    = 3_600
const CACHE_PURGE_INTERVAL_MS = 5 * 60 * 1_000

// ─── StorageService ───────────────────────────────────────────────────────────

export class StorageService {
  private readonly s3:          S3Client
  private readonly bucket:      string
  private readonly enableCache: boolean
  private readonly defaultGetExpiry: number
  private readonly cache = new Map<string, CachedUrl>()
  private purgeTimer?: ReturnType<typeof setInterval>

  constructor(config: StorageConfig) {
    this.s3 = new S3Client({
      region:         config.region,
      endpoint:       config.endpoint,
      forcePathStyle: config.forcePathStyle ?? false,
      credentials: {
        accessKeyId:     config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    })
    this.bucket           = config.bucket
    this.enableCache      = config.enableCache ?? true
    this.defaultGetExpiry = config.defaultGetExpirySeconds ?? DEFAULT_GET_EXPIRY_S

    if (this.enableCache) this.startCachePurge()
  }

  destroy(): void {
    if (this.purgeTimer) clearInterval(this.purgeTimer)
  }

  // ── Upload ───────────────────────────────────────────────────────────────────

  async presignUpload(opts: SignedUploadOptions): Promise<string> {
    const cmd = new PutObjectCommand({
      Bucket:       this.bucket,
      Key:          opts.key,
      ContentType:  opts.contentType,
      CacheControl: opts.cacheControl,
    })
    return getSignedUrl(this.s3, cmd, { expiresIn: opts.expiresIn ?? 600 })
  }

  // ── Download ─────────────────────────────────────────────────────────────────

  async presignGet(key: string, expiresIn?: number): Promise<string> {
    const ttl      = expiresIn ?? this.defaultGetExpiry
    const cacheKey = `${ttl}:${key}`

    if (this.enableCache) {
      const cached = this.cache.get(cacheKey)
      if (cached && cached.expiresAt > Date.now()) return cached.url
    }

    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key })
    const url = await getSignedUrl(this.s3, cmd, { expiresIn: ttl })

    if (this.enableCache) {
      this.cache.set(cacheKey, { url, expiresAt: Date.now() + CACHE_TTL_MS })
    }

    return url
  }

  async presignGetBatch(keys: string[], expiresIn?: number): Promise<(string | null)[]> {
    return Promise.all(keys.map(k => this.presignGet(k, expiresIn).catch(() => null)))
  }

  // ── Range download (magic-byte MIME detection) ────────────────────────────────

  async downloadRange(key: string, start: number, end: number): Promise<Buffer> {
    const out = await this.s3.send(new GetObjectCommand({
      Bucket: this.bucket, Key: key,
      Range: `bytes=${start}-${end}`,
    }))
    if (!out.Body) throw new Error(`Empty body for range ${key}[${start}-${end}]`)
    const chunks: Uint8Array[] = []
    for await (const chunk of out.Body as AsyncIterable<Uint8Array>) chunks.push(chunk)
    return Buffer.concat(chunks)
  }

  // ── Metadata ──────────────────────────────────────────────────────────────────

  async getMetadata(key: string): Promise<StorageObjectMetadata> {
    const out = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
    return {
      contentType:   out.ContentType,
      contentLength: out.ContentLength,
      lastModified:  out.LastModified,
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────────────

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
    this.evict(key)
  }

  // ── Cache ─────────────────────────────────────────────────────────────────────

  evict(key: string): void {
    for (const cacheKey of this.cache.keys()) {
      if (cacheKey.endsWith(`:${key}`)) this.cache.delete(cacheKey)
    }
  }

  get cacheSize(): number { return this.cache.size }

  // ── CDN URL ───────────────────────────────────────────────────────────────────

  cdnUrl(cdnBase: string, key: string): string {
    const base = cdnBase.endsWith('/') ? cdnBase.slice(0, -1) : cdnBase
    return `${base}/${key}`
  }

  // ── Raw S3 client (for processor streaming) ───────────────────────────────────

  get s3Client(): S3Client { return this.s3 }
  get bucketName(): string { return this.bucket }

  // ── Private ───────────────────────────────────────────────────────────────────

  private startCachePurge(): void {
    this.purgeTimer = setInterval(() => {
      const now = Date.now()
      for (const [k, v] of this.cache.entries()) {
        if (v.expiresAt <= now) this.cache.delete(k)
      }
    }, CACHE_PURGE_INTERVAL_MS)
    if (this.purgeTimer.unref) this.purgeTimer.unref()
  }
}
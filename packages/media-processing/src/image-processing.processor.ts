// packages/media-processing/src/image-processing.processor.ts
//
// OPTIMIZED PRODUCTION VERSION
//
// - sharp cached per worker process (no repeated imports)
// - two pipelines only: main WebP + thumb WebP (JPEG removed — nothing reads it)
// - single decode per variant (parallel-safe, EXIF rotation applied once per pipeline)
// - WebP quality: 80 main / 70 thumb
// - 320×240 thumbnail for mobile list views
// - stream → buffer (no temp files)
// - sharp concurrency(1) prevents memory spikes per worker
// - BullMQ retry on failure (attempts: 3, exponential backoff)
//
// Progress:
//   5%   → job received
//   10%  → S3 download complete
//   20%  → sharp pipelines starting
//   65%  → encode done
//   75%  → S3 uploads starting
//   95%  → S3 uploads done
//   100% → DB updated

import { Inject, Logger } from '@nestjs/common'
import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Job } from 'bullmq'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { PrismaService } from '@futsmandu/database'
import { RedisService } from '@futsmandu/redis'
import { QUEUE_IMAGE_PROCESSING } from '@futsmandu/queues'
import { getCacheControl, ImageProcessingJobData } from '@futsmandu/media-core'

// ─────────────────────────────────────────────────────────────
// DI TOKENS
// ─────────────────────────────────────────────────────────────

export const S3_CLIENT_TOKEN      = 'MEDIA_S3_CLIENT'
export const S3_BUCKET_NAME_TOKEN = 'MEDIA_S3_BUCKET'

// ─────────────────────────────────────────────────────────────
// SHARP — lazy-loaded and cached for the lifetime of the worker
// ─────────────────────────────────────────────────────────────

let sharpModule: typeof import('sharp') | null = null
let sharpLoaded = false

async function getSharp(): Promise<typeof import('sharp') | null> {
  if (sharpLoaded) return sharpModule
  sharpLoaded = true
  try {
    sharpModule = (await import('sharp')).default as unknown as typeof import('sharp')
    // Prevent memory spikes when multiple jobs run concurrently inside one worker
    ;(sharpModule as any).concurrency(1)
    return sharpModule
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// RESIZE OPTIONS (shared across pipelines)
// ─────────────────────────────────────────────────────────────

const RESIZE_OPTS = {
  fit:                'cover',
  position:           'centre',
  withoutEnlargement: true,
} as const

// ─────────────────────────────────────────────────────────────
// PROCESSOR
// ─────────────────────────────────────────────────────────────

@Processor(QUEUE_IMAGE_PROCESSING, {
  concurrency: 6, // effort:0 WebP uses less CPU — 6 concurrent jobs safe up to 1 GB
})
export class ImageProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(ImageProcessingProcessor.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,

    @Inject(S3_CLIENT_TOKEN)
    private readonly s3: InstanceType<typeof import('@aws-sdk/client-s3').S3Client>,

    @Inject(S3_BUCKET_NAME_TOKEN)
    private readonly bucket: string,
  ) {
    super()
  }

  // ───────────────────────────────────────────────────────────
  // ENTRY POINT
  // ───────────────────────────────────────────────────────────

  async process(job: Job<ImageProcessingJobData>): Promise<void> {
    if (job.name !== 'process-media') return

    const { assetId, key, assetType, targetWidth, targetHeight } = job.data

    this.logger.log(`[${assetId}] start  key=${key}`)

    try {
      await job.updateProgress(5)

      // ── Load sharp ──────────────────────────────────────────
      const sharp = await getSharp()
      if (!sharp) {
        this.logger.warn(`[${assetId}] sharp unavailable — marking ready without processing`)
        await this.markReady(assetId)
        void this.bustStatusCache(assetId)
        return
      }

      // ── Download from R2/S3 ─────────────────────────────────
      const obj = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      )
      if (!obj.Body) throw new Error(`Empty S3 body for key: ${key}`)

      const chunks: Uint8Array[] = []
      for await (const chunk of obj.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk)
      }
      const input = Buffer.concat(chunks)

      await job.updateProgress(10)

      // ── Output keys ─────────────────────────────────────────
      // Replaces any extension: .jpg / .jpeg / .png / .webp → .webp / _thumb.webp
      const webpKey  = key.replace(/\.[^.]+$/, '.webp')
      const thumbKey = key.replace(/\.[^.]+$/, '_thumb.webp')
      const cacheControl = getCacheControl(assetType)

      await job.updateProgress(20)

      // ── Encode (parallel) ───────────────────────────────────
      // Each pipeline decodes input independently — safe for parallel execution.
      // .rotate() corrects EXIF orientation before any resize.
      const [webpBuf, thumbBuf] = await Promise.all([
        (sharp as any)(input)
          .rotate()
          .resize(targetWidth, targetHeight, RESIZE_OPTS)
          .webp({ quality: 80, effort: 0 })  // effort:0 = fastest encode (~5× faster than effort:3)
          .toBuffer() as Promise<Buffer>,

        (sharp as any)(input)
          .rotate()
          .resize(320, 240, RESIZE_OPTS)
          .webp({ quality: 70, effort: 0 })  // thumb: speed over size
          .toBuffer() as Promise<Buffer>,
      ])

      await job.updateProgress(65)

      // ── Upload variants (parallel) ──────────────────────────
      await job.updateProgress(75)

      await Promise.all([
        this.s3.send(new PutObjectCommand({
          Bucket:       this.bucket,
          Key:          webpKey,
          Body:         webpBuf,
          ContentType:  'image/webp',
          CacheControl: cacheControl,
        })),

        this.s3.send(new PutObjectCommand({
          Bucket:       this.bucket,
          Key:          thumbKey,
          Body:         thumbBuf,
          ContentType:  'image/webp',
          // Thumbs are content-addressed by key — safe to cache aggressively
          CacheControl: 'public, max-age=604800, immutable',
        })),
      ])

      await job.updateProgress(95)

      // ── Persist keys to DB ──────────────────────────────────
      await this.markReady(assetId, webpKey, thumbKey)

      // Bust the status cache so the API owner's next poll gets fresh URLs immediately
      void this.bustStatusCache(assetId)

      await job.updateProgress(100)
      this.logger.log(`[${assetId}] done`)

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(`[${assetId}] failed: ${msg}`)

      // Best-effort status update — don't throw here or it swallows the original error
      await this.prisma.media_assets
        .update({
          where: { id: assetId },
          data:  { status: 'failed', updated_at: new Date() },
        })
        .catch(() => {})

      void this.bustStatusCache(assetId)  // so Flutter stops polling immediately on failure

      throw err // re-throw so BullMQ retries the job
    }
  }

  // ───────────────────────────────────────────────────────────
  // HELPERS
  // ───────────────────────────────────────────────────────────

  /** Delete the Redis status cache for this asset so the next API poll hits the DB. */
  private bustStatusCache(assetId: string): Promise<void> {
    return this.redis.del(`media:status:${assetId}`).catch(() => {})
  }

  private async markReady(
    assetId:  string,
    webpKey?: string,
    thumbKey?: string,
  ): Promise<void> {
    await this.prisma.media_assets.update({
      where: { id: assetId },
      data: {
        status:     'completed',
        webp_key:   webpKey  ?? undefined,
        thumb_key:  thumbKey ?? undefined,
        updated_at: new Date(),
      },
    })
  }
}
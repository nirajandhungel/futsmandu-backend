// packages/media-processing/src/image-processing.processor.ts
//
// OPTIMIZED PRODUCTION VERSION
//
// Improvements:
// - sharp cached per worker process (no repeated imports)
// - single decode per variant pipeline (parallel-safe)
// - WebP quality tuned (80 main, 70 thumb)
// - JPEG uses mozjpeg + progressive encoding
// - EXIF rotation fixed
// - 320×240 thumbnail optimized for mobile lists
// - safer S3 streaming (no temp files)
// - consistent progress updates
// - graceful sharp fallback
// - unified DB update logic
// - reduced memory spikes (sharp concurrency = 1 per worker)
//
// Progress:
//   5%   → job received
//   10%  → download complete
//   20%  → processing start
//   65%  → resize done
//   75%  → upload start
//   95%  → upload done
//   100% → DB updated

import { Inject, Logger } from '@nestjs/common'
import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Job } from 'bullmq'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { PrismaService } from '@futsmandu/database'
import { QUEUE_IMAGE_PROCESSING } from '@futsmandu/queues'
import { getCacheControl, ImageProcessingJobData } from '@futsmandu/media-core'

// ─────────────────────────────────────────────────────────────
// TOKENS
// ─────────────────────────────────────────────────────────────

export const S3_CLIENT_TOKEN      = 'MEDIA_S3_CLIENT'
export const S3_BUCKET_NAME_TOKEN = 'MEDIA_S3_BUCKET'

// ─────────────────────────────────────────────────────────────
// SHARP (cached per worker process)
// ─────────────────────────────────────────────────────────────

let sharpModule: typeof import('sharp') | null = null
let sharpLoaded = false

async function getSharp(): Promise<typeof import('sharp') | null> {
  if (sharpLoaded) return sharpModule
  sharpLoaded = true

  try {
    sharpModule = (await import('sharp')).default as unknown as typeof import('sharp')

    // IMPORTANT: avoid memory spikes in multi-job workers
    ;(sharpModule as any).concurrency(1)

    return sharpModule
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// PROCESSOR
// ─────────────────────────────────────────────────────────────

@Processor(QUEUE_IMAGE_PROCESSING, {
  concurrency: 4, // safe for 512MB–1GB worker container
})
export class ImageProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(ImageProcessingProcessor.name)

  constructor(
    private readonly prisma: PrismaService,
    @Inject(S3_CLIENT_TOKEN)
    private readonly s3Client: InstanceType<typeof import('@aws-sdk/client-s3').S3Client>,
    @Inject(S3_BUCKET_NAME_TOKEN)
    private readonly bucketName: string,
  ) {
    super()
  }

  // ─────────────────────────────────────────────────────────────
  // MAIN JOB
  // ─────────────────────────────────────────────────────────────

  async process(job: Job<ImageProcessingJobData>): Promise<void> {
    if (job.name !== 'process-media') return

    const { assetId, key, assetType, targetWidth, targetHeight } = job.data

    // Skip processing for non-image assets
    if (assetType === 'kyc_document' || assetType === 'venue_verification') {
      await this.markReady(assetId)
      return
    }

    this.logger.log(`[${assetId}] Processing ${key}`)

    try {
      await job.updateProgress(5)

      // ─────────────────────────────────────────────
      // Load sharp (lazy + cached)
      // ─────────────────────────────────────────────
      const sharp = await getSharp()

      if (!sharp) {
        this.logger.warn('sharp not available — skipping processing')
        await this.markReady(assetId)
        return
      }

      // ─────────────────────────────────────────────
      // DOWNLOAD FROM S3 (stream → buffer)
      // ─────────────────────────────────────────────
      const obj = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        }),
      )

      if (!obj.Body) throw new Error(`Empty S3 body: ${key}`)

      const chunks: Uint8Array[] = []
      for await (const chunk of obj.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk)
      }

      const inputBuffer = Buffer.concat(chunks)

      await job.updateProgress(10)

      // ─────────────────────────────────────────────
      // PREP OUTPUT KEYS
      // ─────────────────────────────────────────────
      const webpKey  = key.replace(/\.[^.]+$/, '.webp')
      const jpegKey  = key.replace(/\.[^.]+$/, '.jpg')
      const thumbKey = key.replace(/\.[^.]+$/, '_thumb.webp')

      const cacheControl = getCacheControl(assetType)

      await job.updateProgress(20)

      // ─────────────────────────────────────────────
      // IMAGE PIPELINES (PARALLEL)
      // ─────────────────────────────────────────────
      const resizeOptions = {
        fit: 'cover',
        position: 'centre',
        withoutEnlargement: true,
      } as const

      const pipeline = (input: Buffer) => (sharp as any)(input).rotate()

      const [webpBuffer, jpegBuffer, thumbBuffer] = await Promise.all([
        pipeline(inputBuffer)
          .resize(targetWidth, targetHeight, resizeOptions)
          .webp({ quality: 80, effort: 3 })
          .toBuffer(),

        pipeline(inputBuffer)
          .resize(targetWidth, targetHeight, resizeOptions)
          .jpeg({
            quality: 82,
            progressive: true,
            mozjpeg: true,
          })
          .toBuffer(),

        pipeline(inputBuffer)
          .resize(320, 240, resizeOptions)
          .webp({ quality: 70, effort: 2 })
          .toBuffer(),
      ])

      await job.updateProgress(65)

      // ─────────────────────────────────────────────
      // UPLOAD ALL VARIANTS (PARALLEL)
      // ─────────────────────────────────────────────
      await job.updateProgress(75)

      await Promise.all([
        this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucketName,
            Key: webpKey,
            Body: webpBuffer,
            ContentType: 'image/webp',
            CacheControl: cacheControl,
          }),
        ),

        this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucketName,
            Key: jpegKey,
            Body: jpegBuffer,
            ContentType: 'image/jpeg',
            CacheControl: cacheControl,
          }),
        ),

        this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucketName,
            Key: thumbKey,
            Body: thumbBuffer,
            ContentType: 'image/webp',
            CacheControl: 'public, max-age=604800', // immutable thumbs
          }),
        ),
      ])

      await job.updateProgress(95)

      // ─────────────────────────────────────────────
      // DB UPDATE (single write)
      // ─────────────────────────────────────────────
      await this.markReady(assetId, webpKey, thumbKey)

      await job.updateProgress(100)

      this.logger.log(`[${assetId}] DONE`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)

      this.logger.error(`[${assetId}] FAILED: ${msg}`)

      await this.prisma.media_assets.update({
        where: { id: assetId },
        data: {
          status: 'failed',
          updatedAt: new Date(),
        },
      }).catch(() => {})

      throw err // allow BullMQ retry
    }
  }

  // ─────────────────────────────────────────────────────────────
  // DB HELPER
  // ─────────────────────────────────────────────────────────────

  private async markReady(
    assetId: string,
    webpKey?: string,
    thumbKey?: string,
  ): Promise<void> {
    await this.prisma.media_assets.update({
      where: { id: assetId },
      data: {
        status: 'ready',
        progress: 100,
        webpKey: webpKey ?? undefined,
        thumbKey: thumbKey ?? undefined,
        updatedAt: new Date(),
      },
    })
  }
}

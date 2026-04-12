// packages/media-processing/src/image-processing.processor.ts
//
// BullMQ processor: downloads original from R2, resizes to WebP + JPEG + thumb,
// uploads all three in parallel, updates DB status to 'ready'.
//
// Progress stages (reported via job.updateProgress):
//   0%  → job received
//   10% → original downloaded
//   20% → resize started
//   60% → resize complete
//   70% → uploads started
//   90% → uploads complete
//   100%→ DB updated, done

import { Inject, Logger } from '@nestjs/common'
import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Job } from 'bullmq'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { PrismaService } from '@futsmandu/database'
import { QUEUE_IMAGE_PROCESSING } from '@futsmandu/queues'
import { getCacheControl, ImageProcessingJobData } from '@futsmandu/media-core'

// These tokens are provided by MediaModule.forWorker() / the app that registers
// the processor. Keep them here as the canonical token names.
export const S3_CLIENT_TOKEN      = 'MEDIA_S3_CLIENT'
export const S3_BUCKET_NAME_TOKEN = 'MEDIA_S3_BUCKET'

@Processor(QUEUE_IMAGE_PROCESSING, {
  concurrency: 4,  // process up to 4 images simultaneously per worker instance
})
export class ImageProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(ImageProcessingProcessor.name)

  constructor(
    private readonly prisma: PrismaService,
    @Inject(S3_CLIENT_TOKEN) private readonly s3Client: InstanceType<typeof import('@aws-sdk/client-s3').S3Client>,
    @Inject(S3_BUCKET_NAME_TOKEN) private readonly bucketName: string,
  ) {
    super()
  }

  async process(job: Job<ImageProcessingJobData>): Promise<void> {
    if (job.name !== 'process-media') return

    const { assetId, key, assetType, targetWidth, targetHeight } = job.data

    if (assetType === 'kyc_document') {
      // KYC docs (PDF/images) skip resize — mark ready immediately
      await this.markReady(assetId)
      return
    }

    this.logger.log(`Processing ${assetId}: ${key} → ${targetWidth}×${targetHeight}`)

    try {
      // ── Dynamic import — sharp is an optional native dep ─────────────────
      let sharp: typeof import('sharp')
      try {
        sharp = (await import('sharp')).default as unknown as typeof import('sharp')
      } catch {
        this.logger.warn('sharp not installed — skipping resize. Run: pnpm add sharp')
        await this.markReady(assetId)
        return
      }

      await job.updateProgress(5)

      // ── Stage 1: Download original ───────────────────────────────────────
      const obj = await this.s3Client.send(new GetObjectCommand({
        Bucket: this.bucketName,
        Key:    key,
      }))
      if (!obj.Body) throw new Error(`Empty S3 body: ${key}`)

      const chunks: Uint8Array[] = []
      for await (const chunk of obj.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk)
      }
      const inputBuffer = Buffer.concat(chunks)
      await job.updateProgress(10)

      // ── Stage 2: Resize all formats in parallel ──────────────────────────
      await job.updateProgress(20)

      const cacheControl = getCacheControl(assetType)
      const webpKey      = key.replace(/\.[^.]+$/, '.webp')
      const jpegKey      = key.replace(/\.[^.]+$/, '.jpg')
      const thumbKey     = key.replace(/\.[^.]+$/, '_thumb.webp')

      const sharpFn = sharp as unknown as (buf: Buffer) => import('sharp').Sharp

      const resizeOpts = { fit: 'cover', position: 'centre', withoutEnlargement: true } as const

      const [resizedWebp, resizedJpeg, thumb] = await Promise.all([
        sharpFn(inputBuffer)
          .resize(targetWidth, targetHeight, resizeOpts)
          .webp({ quality: 85 })
          .toBuffer(),

        sharpFn(inputBuffer)
          .resize(targetWidth, targetHeight, resizeOpts)
          .jpeg({ quality: 85, progressive: true })
          .toBuffer(),

        // Thumbnail: always 400×300 WebP — optimal for Flutter list views
        sharpFn(inputBuffer)
          .resize(400, 300, resizeOpts)
          .webp({ quality: 75 })
          .toBuffer(),
      ])
      await job.updateProgress(60)

      // ── Stage 3: Upload all three in parallel ───────────────────────────
      await job.updateProgress(70)

      await Promise.all([
        this.s3Client.send(new PutObjectCommand({
          Bucket: this.bucketName, Key: webpKey,
          Body: resizedWebp, ContentType: 'image/webp', CacheControl: cacheControl,
        })),
        this.s3Client.send(new PutObjectCommand({
          Bucket: this.bucketName, Key: jpegKey,
          Body: resizedJpeg, ContentType: 'image/jpeg', CacheControl: cacheControl,
        })),
        this.s3Client.send(new PutObjectCommand({
          Bucket: this.bucketName, Key: thumbKey,
          Body: thumb, ContentType: 'image/webp', CacheControl: cacheControl,
        })),
      ])
      await job.updateProgress(90)

      // ── Stage 4: Mark ready ──────────────────────────────────────────────
      await this.markReady(assetId, webpKey, thumbKey)
      await job.updateProgress(100)

      this.logger.log(`Done ${assetId}: webp=${webpKey}`)
    } catch (err: unknown) {
      this.logger.error(
        `Failed processing ${assetId}: ${err instanceof Error ? err.message : String(err)}`,
      )
      await this.prisma.media_assets.update({
        where: { id: assetId },
        data:  { status: 'failed', updatedAt: new Date() },
      }).catch(() => {})
      throw err  // re-throw so BullMQ records failure and retries
    }
  }

  private async markReady(assetId: string, webpKey?: string, thumbKey?: string): Promise<void> {
    await this.prisma.media_assets.update({
      where: { id: assetId },
      data: {
        status:    'ready',
        webpKey:   webpKey   ?? undefined,
        thumbKey:  thumbKey  ?? undefined,
        updatedAt: new Date(),
      },
    })
  }
}

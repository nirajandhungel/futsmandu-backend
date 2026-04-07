import { Inject } from '@nestjs/common'
import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Job } from 'bullmq'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { PrismaService } from '@futsmandu/database'
import { QUEUE_IMAGE_PROCESSING } from '@futsmandu/queues'
import { getCacheControl, ImageProcessingJobData } from '@futsmandu/media-core'

export const S3_CLIENT_TOKEN = 'S3_CLIENT_TOKEN'
export const S3_BUCKET_NAME_TOKEN = 'S3_BUCKET_NAME_TOKEN'

@Processor(QUEUE_IMAGE_PROCESSING)
export class ImageProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(ImageProcessingProcessor.name)

  constructor(
    private readonly prisma: PrismaService,
    @Inject(S3_CLIENT_TOKEN) private readonly s3Client: S3Client,
    @Inject(S3_BUCKET_NAME_TOKEN) private readonly bucketName: string,
  ) {
    super()
  }

  async process(job: Job<ImageProcessingJobData>): Promise<void> {
    if (job.name !== 'process-media') return

    const { assetId, key, assetType, targetWidth, targetHeight } = job.data
    if (assetType === 'kyc_document') {
      this.logger.warn(`Skipping image processor for PDF/KYC asset ${assetId}: ${key}`)
      await this.markReady(assetId)
      return
    }
    this.logger.log(`Processing image asset ${assetId}: ${key}`)

    try {
      let sharp: typeof import('sharp')
      try {
        sharp = (await import('sharp')).default as unknown as typeof import('sharp')
      } catch {
        this.logger.warn('Sharp not installed — skipping image resize. Run: pnpm add sharp')
        await this.markReady(assetId)
        return
      }

      const s3 = this.s3Client
      const bucket = this.bucketName

      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      if (!obj.Body) throw new Error(`Empty S3 object body for key: ${key}`)

      const chunks: Uint8Array[] = []
      for await (const chunk of obj.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk)
      }
      const inputBuffer = Buffer.concat(chunks)

      const cacheControl = getCacheControl(assetType)

      const webpKey = key.replace(/\.[^.]+$/, '.webp')
      const resizedWebp = await (sharp as unknown as (buf: Buffer) => import('sharp').Sharp)(inputBuffer)
        .resize(targetWidth, targetHeight, { fit: 'cover', position: 'centre', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer()

      await s3.send(new PutObjectCommand({
        Bucket:       bucket,
        Key:          webpKey,
        Body:         resizedWebp,
        ContentType:  'image/webp',
        CacheControl: cacheControl,
      }))

      // Overwrite the original extension file but safely parsed
      const jpegKey = key.replace(/\.[^.]+$/, '.jpg')
      const resizedJpeg = await (sharp as unknown as (buf: Buffer) => import('sharp').Sharp)(inputBuffer)
        .resize(targetWidth, targetHeight, { fit: 'cover', position: 'centre', withoutEnlargement: true })
        .jpeg({ quality: 85, progressive: true })
        .toBuffer()

      await s3.send(new PutObjectCommand({
        Bucket:       bucket,
        Key:          jpegKey,
        Body:         resizedJpeg,
        ContentType:  'image/jpeg',
        CacheControl: cacheControl,
      }))

      const thumbKey = key.replace(/\.[^.]+$/, '_thumb.jpg')
      const thumb = await (sharp as unknown as (buf: Buffer) => import('sharp').Sharp)(inputBuffer)
        .resize(400, 300, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 75 })
        .toBuffer()

      await s3.send(new PutObjectCommand({
        Bucket:       bucket,
        Key:          thumbKey,
        Body:         thumb,
        ContentType:  'image/jpeg',
        CacheControl: cacheControl,
      }))

      await this.markReady(assetId, webpKey)

      this.logger.log(`Image processed: ${key} → ${targetWidth}×${targetHeight} (JPEG + WebP + thumb)`)
    } catch (err: unknown) {
      this.logger.error(`Image processing failed for asset ${job.data.assetId}: ${job.data.key}`, err instanceof Error ? err.stack : String(err))
      await this.prisma.media_assets.update({
        where: { id: job.data.assetId },
        data:  { status: 'failed', updatedAt: new Date() },
      }).catch(() => {}) 
      throw err 
    }
  }

  private async markReady(assetId: string, webpKey?: string): Promise<void> {
    await this.prisma.media_assets.update({
      where: { id: assetId },
      data:  {
        status:    'ready',
        webpKey:   webpKey ?? undefined,
        updatedAt: new Date(),
      },
    })
  }
}

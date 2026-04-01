// apps/owner-api/src/workers/processors/image-processing.processor.ts
// Resizes venue images after owner uploads to R2 via presigned URL.
// Sharp: resize to target dimensions, re-upload to same key in R2.
// Generates thumbnail alongside main image for gallery.
import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Job } from 'bullmq'
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { ENV } from '@futsmandu/utils'

interface ImageResizeJobData {
  key: string
  bucket: string
  targetWidth: number
  targetHeight: number
}

@Processor('image-processing')
export class ImageProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(ImageProcessingProcessor.name)
  private readonly s3: S3Client

  constructor() {
    super()
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${ENV['CF_ACCOUNT_ID']}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: ENV['R2_ACCESS_KEY_ID'],
        secretAccessKey: ENV['R2_SECRET_ACCESS_KEY'],
      },
    })
  }

  async process(job: Job<ImageResizeJobData>): Promise<void> {
    if (job.name !== 'resize-image') return
    const { key, bucket, targetWidth, targetHeight } = job.data

    this.logger.log(`Processing image: ${key}`, { jobId: job.id })

    // Dynamically import Sharp (not installed in all environments — add to package.json)
    let sharp: typeof import('sharp')
    try {
      sharp = (await import('sharp')).default as unknown as typeof import('sharp')
    } catch {
      this.logger.warn('Sharp not installed — image resize skipped. Run: npm i sharp')
      return
    }

    // Download from R2
    const getCmd = new GetObjectCommand({ Bucket: bucket, Key: key })
    const obj = await this.s3.send(getCmd)

    if (!obj.Body) {
      this.logger.warn(`Empty body for key ${key}`)
      return
    }

    // Convert stream to buffer
    const chunks: Uint8Array[] = []
    for await (const chunk of obj.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk)
    }
    const inputBuffer = Buffer.concat(chunks)

    // Resize main image
    const resized = await (sharp as unknown as (buf: Buffer) => import('sharp').Sharp)(inputBuffer)
      .resize(targetWidth, targetHeight, {
        fit: 'cover',
        position: 'centre',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85, progressive: true })
      .toBuffer()

    // Re-upload resized image to same key
    await this.s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: resized,
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=86400',
    }))

    // Generate thumbnail (400x300) alongside main image
    const thumbKey = key.replace(/\.jpg$/, '_thumb.jpg')
    const thumb = await (sharp as unknown as (buf: Buffer) => import('sharp').Sharp)(inputBuffer)
      .resize(400, 300, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 75 })
      .toBuffer()

    await this.s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: thumbKey,
      Body: thumb,
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=604800',
    }))

    this.logger.log(`Image processed: ${key} → ${targetWidth}×${targetHeight} + thumb`, { jobId: job.id })
  }
}

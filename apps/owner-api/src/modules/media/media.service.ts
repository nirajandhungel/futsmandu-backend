// apps/owner-api/src/modules/media/media.service.ts
// Cloudflare R2 media service for owner-api.
// Generates presigned PUT URLs (10 min) — client uploads directly to R2 (no data through server).
// Sharp resize job enqueued to BullMQ image-processing queue after upload confirmation.
import { Injectable, BadRequestException, Logger } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { PrismaService } from '@futsmandu/database'
import type { Prisma } from '@futsmandu/database'
import { ENV } from '@futsmandu/utils'

export type AssetFolder = 'venues' | 'avatars' | 'courts' | 'verify'

export interface UploadUrlResult {
  uploadUrl: string
  cdnUrl: string
  key: string
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name)
  private readonly s3: S3Client

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('image-processing') private readonly imageQueue: Queue,
  ) {
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${ENV['CF_ACCOUNT_ID']}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId:     ENV['R2_ACCESS_KEY_ID'],
        secretAccessKey: ENV['R2_SECRET_ACCESS_KEY'],
      },
    })
  }

  // ── Venue cover image presigned URL ──────────────────────────────────────
  async getVenueCoverUploadUrl(ownerId: string, venueId: string): Promise<UploadUrlResult> {
    await this.assertVenueOwnership(venueId, ownerId)

    const key    = `venues/${venueId}/cover.jpg`
    const result = await this.generatePresignedUrl(key, 'image/jpeg', 'public, max-age=86400')

    // Pre-store CDN URL — becomes live after upload and processing
    await this.prisma.venues.update({
      where: { id: venueId },
      data:  { cover_image_url: result.cdnUrl, updated_at: new Date() },
    })

    return result
  }

  // ── Venue gallery image presigned URL ─────────────────────────────────────
  async getVenueGalleryUploadUrl(ownerId: string, venueId: string): Promise<UploadUrlResult> {
    await this.assertVenueOwnership(venueId, ownerId)

    const uuid   = crypto.randomUUID()
    const key    = `venues/${venueId}/gallery/${uuid}.jpg`
    return this.generatePresignedUrl(key, 'image/jpeg', 'public, max-age=604800')
  }

  // ── Owner verification document presigned URL ─────────────────────────────
  // Documents are PRIVATE — never served via CDN. Admin accesses via presigned GET URL.
  async getDocumentUploadUrl(ownerId: string, docType: string): Promise<{ uploadUrl: string; key: string }> {
    const allowed = ['nid_front', 'nid_back', 'business_registration', 'tax_certificate']
    if (!allowed.includes(docType)) {
      throw new BadRequestException(`Invalid docType. Allowed: ${allowed.join(', ')}`)
    }

    const key = `verify/${ownerId}/${docType}.pdf`
    const cmd = new PutObjectCommand({
      Bucket:       ENV['R2_BUCKET_NAME'],
      Key:          key,
      ContentType:  'application/pdf',
      CacheControl: 'no-store, private',
    })

    const uploadUrl = await getSignedUrl(this.s3, cmd, { expiresIn: 600 })

    // Record doc key in owner's verification_docs JSON field
    const current = await this.prisma.owners.findUnique({
      where: { id: ownerId },
      select: { verification_docs: true },
    })
    const existing: Prisma.InputJsonObject =
      current?.verification_docs && typeof current.verification_docs === 'object'
        ? (current.verification_docs as Prisma.InputJsonObject)
        : {}
    const updatedDocs: Prisma.InputJsonObject = { ...(existing as Record<string, Prisma.InputJsonValue>), [docType]: key }
    await this.prisma.owners.update({
      where: { id: ownerId },
      data:  { verification_docs: updatedDocs, updated_at: new Date() },
    })

    return { uploadUrl, key }
  }

  // ── Confirm upload complete + enqueue resize job ──────────────────────────
  // Client calls this after successful R2 upload to trigger Sharp processing.
  async confirmUpload(key: string, targetWidth: number, targetHeight: number): Promise<void> {
    await this.imageQueue
      .add(
        'resize-image',
        { key, targetWidth, targetHeight, bucket: ENV['R2_BUCKET_NAME'] },
        { attempts: 2, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 50, removeOnFail: 100 },
      )
      .catch((e: unknown) => this.logger.error('Failed to enqueue image resize', e))
  }

  // ── Delete R2 object ──────────────────────────────────────────────────────
  async deleteObject(ownerId: string, key: string): Promise<void> {
    // Only allow deleting own venue assets
    if (!key.startsWith(`venues/`) && !key.startsWith(`verify/${ownerId}/`)) {
      throw new BadRequestException('Cannot delete this asset')
    }

    await this.s3.send(new DeleteObjectCommand({
      Bucket: ENV['R2_BUCKET_NAME'],
      Key:    key,
    }))

    this.logger.log(`R2 object deleted: ${key} by owner ${ownerId}`)
  }

  // ── Core: generate presigned PUT URL ─────────────────────────────────────
  private async generatePresignedUrl(
    key: string,
    contentType: string,
    cacheControl: string,
  ): Promise<UploadUrlResult> {
    const cmd = new PutObjectCommand({
      Bucket:       ENV['R2_BUCKET_NAME'],
      Key:          key,
      ContentType:  contentType,
      CacheControl: cacheControl,
    })

    const uploadUrl = await getSignedUrl(this.s3, cmd, { expiresIn: 600 })
    const cdnUrl    = `${ENV['R2_CDN_BASE_URL']}/${key}`

    return { uploadUrl, cdnUrl, key }
  }

  // ── Ownership guard ───────────────────────────────────────────────────────
  private async assertVenueOwnership(venueId: string, ownerId: string): Promise<void> {
    const venue = await this.prisma.venues.findFirst({
      where:  { id: venueId, owner_id: ownerId },
      select: { id: true },
    })
    if (!venue) throw new BadRequestException('Venue not found or access denied')
  }
}

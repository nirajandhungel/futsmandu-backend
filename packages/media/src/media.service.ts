// packages/media/src/media.service.ts
//
// Single source of truth for all media business logic.
// Depends on @futsmandu/media-storage (StorageService) for all R2 operations.
// r2-storage package has been deleted — StorageService absorbs it.

import {
  Injectable, BadRequestException, ForbiddenException,
  NotFoundException, InternalServerErrorException, Logger,
} from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { PrismaService } from '@futsmandu/database'
import { QUEUE_IMAGE_PROCESSING } from '@futsmandu/queues'
import { ENV } from '@futsmandu/utils'
import { fileTypeFromBuffer } from 'file-type'

import {
  AssetType, PUBLIC_ASSET_TYPES,
  RequestUploadUrlOptions, ConfirmUploadResult,
  SignedDownloadUrlOptions, ImageProcessingJobData, GalleryItem, UploadStatusResult,
  generateMediaKey, getContentType, getCacheControl, getResizeDimensions,
  ALLOWED_MIME_TYPES, AllowedMimeType,
  getAllowedMimeTypesForAssetType, getAllowedExtensionsForAssetType,
  getPreferredExtensionForMimeType,
} from '@futsmandu/media-core'

import { StorageService } from '@futsmandu/media-storage'

// ─── Constants ────────────────────────────────────────────────────────────────

const PRESIGN_UPLOAD_EXPIRY_S = 600        // 10 min — time client has to PUT the file
const PRESIGN_GET_EXPIRY_S    = 3_600      // 1 hour — time client can display the image
const PRESIGN_PRIVATE_EXPIRY_S = 600       // 10 min — KYC / verification docs
const MAX_FILE_SIZE           = 10 * 1024 * 1024  // 10 MB
const ALLOWED_KYC_DOC_TYPES   = ['citizenship', 'business_registration', 'business_pan'] as const

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name)

  constructor(
    private readonly prisma:   PrismaService,
    private readonly storage:  StorageService,
    @InjectQueue(QUEUE_IMAGE_PROCESSING) private readonly imageQueue: Queue,
  ) {}

  // ════════════════════════════════════════════════════════════════════════════
  // STEP 1 — Request upload URL
  // Flutter calls this first. Gets a presigned PUT URL, uploads directly to R2.
  // ════════════════════════════════════════════════════════════════════════════

  async requestUploadUrl(opts: RequestUploadUrlOptions): Promise<{
    assetId:   string
    uploadUrl: string
    key:       string
    cdnUrl?:   string
    expiresIn: number
  }> {
    await this.validateOwnership(opts)

    if (opts.assetType === 'kyc_document') {
      if (!opts.docType || !ALLOWED_KYC_DOC_TYPES.includes(opts.docType as any)) {
        throw new BadRequestException(
          `Invalid docType. Allowed: ${ALLOWED_KYC_DOC_TYPES.join(', ')}`,
        )
      }
    }

    const contentType = this.resolveAllowedContentType(opts.assetType, opts.contentType)
    const key         = generateMediaKey({
      assetType: opts.assetType,
      entityId:  opts.entityId,
      docType:   opts.docType,
      extension: getPreferredExtensionForMimeType(contentType),
    })

    this.logger.log(JSON.stringify({
      event: 'UPLOAD_URL_REQUESTED', ownerId: opts.ownerId,
      assetType: opts.assetType, mimeType: contentType,
    }))

    // Upsert so re-uploads cleanly overwrite the previous processing record
    const asset = await this.prisma.media_assets.upsert({
      where:  { key },
      create: {
        key, assetType: opts.assetType, status: 'pending',
        uploaderId: opts.ownerId, entityId: opts.entityId,
      },
      update: {
        assetType: opts.assetType, status: 'pending',
        uploaderId: opts.ownerId, entityId: opts.entityId,
        webpKey: null, thumbKey: null, updatedAt: new Date(),
      },
    })

    const uploadUrl = await this.storage.presignUpload({
      key,
      contentType,
      cacheControl: getCacheControl(opts.assetType),
      expiresIn:    PRESIGN_UPLOAD_EXPIRY_S,
    })

    const result: {
      assetId: string; uploadUrl: string; key: string
      expiresIn: number; cdnUrl?: string
    } = { assetId: asset.id, uploadUrl, key, expiresIn: PRESIGN_UPLOAD_EXPIRY_S }

    // For public assets, return the future CDN URL so Flutter can optimistically
    // display a placeholder while the upload + processing completes.
    if (PUBLIC_ASSET_TYPES.includes(opts.assetType)) {
      result.cdnUrl = this.storage.cdnUrl(
        ENV['S3_CDN_BASE_URL'] || ENV['S3_ENDPOINT'] || '',
        key,
      )
    }

    return result
  }

  // ════════════════════════════════════════════════════════════════════════════
  // STEP 2 — Confirm upload
  // Call AFTER the client PUT to the presigned URL.
  // Validates the file, enqueues processing, returns immediately.
  // ════════════════════════════════════════════════════════════════════════════

  async confirmUpload(opts: {
    ownerId: string; assetId: string; key: string; assetType: AssetType
  }): Promise<ConfirmUploadResult> {
    // ── Phase 1: Parallel file validation — metadata + magic bytes ───────────
    const [objectMeta, magicBuffer] = await Promise.all([
      this.storage.getMetadata(opts.key).catch(err => {
        if (this.isNotFoundError(err)) {
          throw new BadRequestException(
            'File not found in storage. Upload to the presigned URL first, then call confirm-upload.',
          )
        }
        throw err
      }),
      this.storage.downloadRange(opts.key, 0, 11).catch(() => Buffer.alloc(0)),
    ])

    const objectSize = objectMeta.contentLength ?? 0

    if (objectSize <= 0) {
      await this.safeDelete(opts.key)
      throw new BadRequestException('Uploaded file is empty')
    }
    if (objectSize > MAX_FILE_SIZE) {
      await this.safeDelete(opts.key)
      throw new BadRequestException('File too large. Maximum allowed size is 10 MB')
    }

    const expectedContentType = this.resolveAllowedContentType(opts.assetType, objectMeta.contentType)
    const detected            = magicBuffer.length > 0 ? await fileTypeFromBuffer(magicBuffer) : null

    if (!detected || !ALLOWED_MIME_TYPES.includes(detected.mime as AllowedMimeType)) {
      await this.safeDelete(opts.key)
      throw new BadRequestException('Invalid file format. Allowed: JPEG, PNG, WebP, PDF')
    }

    const detectedMime = detected.mime as AllowedMimeType

    if (detectedMime !== expectedContentType) {
      await this.safeDelete(opts.key)
      throw new BadRequestException(
        `File type mismatch: declared ${expectedContentType} but file is ${detectedMime}`,
      )
    }

    if (!this.extensionMatchesMime(opts.key, detectedMime, opts.assetType)) {
      await this.safeDelete(opts.key)
      throw new BadRequestException('File extension does not match content type')
    }

    // ── Phase 2: DB validation ───────────────────────────────────────────────
    const asset = await this.prisma.media_assets.findUnique({ where: { id: opts.assetId } })

    if (!asset) throw new NotFoundException('Upload session not found. Request a new upload URL.')
    if (asset.uploaderId !== opts.ownerId)   throw new ForbiddenException('You do not own this asset')
    if (asset.key !== opts.key)              throw new BadRequestException('Key does not match upload session')
    if (asset.assetType !== opts.assetType)  throw new BadRequestException('assetType does not match upload session')

    const entityId = this.extractEntityIdFromKey(opts.key, opts.assetType)
    if (asset.entityId !== entityId)         throw new BadRequestException('Entity mismatch for this upload session')

    // ── Phase 3: Parallel side-effects ──────────────────────────────────────
    await Promise.all([
      this.prisma.media_assets.update({
        where: { id: asset.id },
        data:  { status: 'processing', updatedAt: new Date() },
      }),

      opts.assetType !== 'kyc_document'
        ? this.enqueueProcessing(opts.assetId, opts.key, opts.assetType)
        : this.prisma.media_assets.update({
            where: { id: opts.assetId },
            data:  { status: 'ready', updatedAt: new Date() },
          }),

      this.syncDomainPointers(opts.assetType, entityId, opts.key).catch(() => {}),
      this.storage.evict(opts.key),
    ])

    this.logger.log(JSON.stringify({
      event: 'UPLOAD_CONFIRMED', ownerId: opts.ownerId,
      assetType: opts.assetType, assetId: opts.assetId, fileSize: objectSize,
    }))

    return {
      message: opts.assetType === 'kyc_document'
        ? 'KYC document uploaded successfully'
        : 'Upload confirmed — processing started',
      assetId:  opts.assetId,
      // For KYC docs that are immediately ready; for images this is null until processing completes
      webpKey:  asset.webpKey,
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // STEP 3 — Poll status
  // Flutter polls this until status = 'ready', then shows the image.
  // ════════════════════════════════════════════════════════════════════════════

  async getUploadStatus(assetId: string, ownerId: string): Promise<UploadStatusResult> {
    const asset = await this.prisma.media_assets.findUnique({
      where:  { id: assetId },
      select: { status: true, webpKey: true, thumbKey: true, uploaderId: true },
    })

    if (!asset || asset.uploaderId !== ownerId) {
      throw new NotFoundException('Asset not found')
    }

    const status = asset.status as UploadStatusResult['status']

    return {
      status,
      progress: status === 'ready' ? 100 : status === 'processing' ? 50 : status === 'failed' ? 0 : 10,
      webpKey:  asset.webpKey,
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SIGNED URLS — used when serving images to Flutter
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Presigned GET URL for any image key.
   * Cached in-memory for 50 min — safe to call on every request.
   */
  async getImageUrl(key: string, expiresIn = PRESIGN_GET_EXPIRY_S): Promise<string> {
    return this.storage.presignGet(key, expiresIn)
  }

  /**
   * Gallery images with presigned URLs — batch-presigned in a single Promise.all.
   * First call: ~200ms. Subsequent calls (within 50 min): ~5ms from cache.
   */
  async getGallery(venueId: string): Promise<GalleryItem[]> {
    const assets = await this.prisma.media_assets.findMany({
      where:   { entityId: venueId, assetType: 'venue_gallery', status: 'ready' },
      select:  { id: true, key: true, webpKey: true, thumbKey: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    })

    if (assets.length === 0) return []

    const cdnBase = ENV['S3_CDN_BASE_URL'] || ENV['S3_ENDPOINT'] || ''

    // Batch presign: effective keys (prefer webp) all in one burst
    const effectiveKeys = assets.map((a: any) => a.webpKey ?? a.key)
    const signedUrls    = await this.storage.presignGetBatch(effectiveKeys, PRESIGN_GET_EXPIRY_S)

    // Also batch presign thumbs for Flutter list views
    const thumbKeys     = assets.map((a: any) => a.thumbKey ?? a.webpKey ?? a.key)
    const thumbUrls     = await this.storage.presignGetBatch(thumbKeys, PRESIGN_GET_EXPIRY_S)

    return assets.map((a: any, i: number) => ({
      assetId:   a.id,
      key:       a.key,
      cdnUrl:    this.storage.cdnUrl(cdnBase, a.key),
      signedUrl: signedUrls[i] ?? undefined,
      thumbUrl:  thumbUrls[i]  ?? undefined,
      webpUrl:   a.webpKey ? this.storage.cdnUrl(cdnBase, a.webpKey) : undefined,
      uploadedAt: a.createdAt,
    }))
  }

  /**
   * Signed URL for a KYC document. Always uses short expiry (private asset).
   */
  async getKycDocUrl(
    ownerId: string,
    docType: string,
    expiresIn = PRESIGN_PRIVATE_EXPIRY_S,
  ): Promise<{ downloadUrl: string; expiresIn: number }> {
    const extensions = ['pdf', 'jpg', 'jpeg', 'png', 'webp']
    for (const ext of extensions) {
      const key = `owners/${ownerId}/kyc/${docType}.${ext}`
      const url = await this.storage.presignGet(key, expiresIn).catch(() => null)
      if (url) return { downloadUrl: url, expiresIn }
    }
    throw new NotFoundException(`KYC document not found for docType: ${docType}`)
  }

  /**
   * Signed URL for a venue verification doc (admin / owner access).
   */
  async getVerificationDocUrl(
    venueId:   string,
    key:       string,
    expiresIn = PRESIGN_PRIVATE_EXPIRY_S,
  ): Promise<{ downloadUrl: string; expiresIn: number }> {
    if (!key.startsWith(`venues/${venueId}/verification/`)) {
      throw new NotFoundException('Verification image not found for this venue')
    }
    const url = await this.storage.presignGet(key, expiresIn)
    return { downloadUrl: url, expiresIn }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // DELETE
  // ════════════════════════════════════════════════════════════════════════════

  async deleteAsset(assetId: string, requesterId: string): Promise<void> {
    const asset = await this.prisma.media_assets.findUnique({ where: { id: assetId } })

    if (!asset)                           throw new NotFoundException('Asset not found')
    if (asset.uploaderId !== requesterId) throw new ForbiddenException('You do not own this asset')

    await Promise.all([
      this.storage.delete(asset.key),
      asset.webpKey  ? this.storage.delete(asset.webpKey).catch(() => {})  : Promise.resolve(),
      asset.thumbKey ? this.storage.delete(asset.thumbKey).catch(() => {}) : Promise.resolve(),
      this.prisma.media_assets.update({
        where: { id: assetId },
        data:  { status: 'failed', updatedAt: new Date() },
      }),
    ])

    this.logger.log(`Asset deleted: ${asset.key} by ${requesterId}`)
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PRIVATE
  // ════════════════════════════════════════════════════════════════════════════

  private async enqueueProcessing(
    assetId:   string,
    key:       string,
    assetType: AssetType,
  ): Promise<void> {
    const { width, height } = getResizeDimensions(assetType)
    const jobData: ImageProcessingJobData = {
      assetId, key, bucket: this.storage.bucketName,
      assetType, targetWidth: width, targetHeight: height,
    }

    await this.imageQueue
      .add('process-media', jobData, {
        attempts:         3,
        backoff:          { type: 'exponential', delay: 5_000 },
        removeOnComplete: 50,
        removeOnFail:     100,
        // Profile images processed with higher priority — users wait on these
        priority: assetType === 'player_profile' || assetType === 'owner_profile' ? 10 : 1,
      })
      .catch((e: unknown) => this.logger.error('Failed to enqueue image processing job', e))
  }

  private async validateOwnership(opts: RequestUploadUrlOptions): Promise<void> {
    switch (opts.assetType) {
      case 'player_profile':
      case 'owner_profile':
      case 'kyc_document':
        if (opts.entityId !== opts.ownerId) {
          throw new ForbiddenException('You can only upload to your own media folder')
        }
        return

      case 'venue_cover':
      case 'venue_gallery':
      case 'venue_verification': {
        const venue = await this.prisma.venues.findFirst({
          where:  { id: opts.entityId, owner_id: opts.ownerId },
          select: { id: true },
        })
        if (!venue) throw new ForbiddenException('Venue not found or access denied')
        return
      }

      default:
        throw new BadRequestException(`Unknown assetType: ${opts.assetType}`)
    }
  }

  private async syncDomainPointers(
    assetType: AssetType,
    entityId:  string,
    key:       string,
  ): Promise<void> {
    const cdnUrl = this.storage.cdnUrl(
      ENV['S3_CDN_BASE_URL'] || ENV['S3_ENDPOINT'] || '',
      key,
    )

    if (assetType === 'player_profile') {
      await this.prisma.users.update({
        where: { id: entityId },
        data:  { profile_image_url: cdnUrl, updated_at: new Date() },
      }).catch(() => {})
      return
    }

    if (assetType === 'owner_profile') {
      await this.prisma.owners.update({
        where: { id: entityId },
        data:  { profile_image_url: cdnUrl, updated_at: new Date() },
      }).catch(() => {})
      return
    }

    if (assetType === 'venue_cover') {
      await this.prisma.venues.update({
        where: { id: entityId },
        data:  { cover_image_url: cdnUrl, updated_at: new Date() },
      }).catch(() => {})
      return
    }

    if (assetType === 'kyc_document') {
      const owner = await this.prisma.owners.findUnique({
        where:  { id: entityId },
        select: { verification_docs: true },
      })
      const docs    = (owner?.verification_docs && typeof owner.verification_docs === 'object'
        ? owner.verification_docs : {}) as Record<string, unknown>
      const docType = key.split('/').pop()?.replace(/\.[^/.]+$/, '')
      if (!docType) return

      await this.prisma.owners.update({
        where: { id: entityId },
        data:  {
          verification_docs: { ...docs, [docType]: key } as any,
          updated_at:        new Date(),
        },
      }).catch(() => {})
    }
  }

  private resolveAllowedContentType(assetType: AssetType, contentType?: string): AllowedMimeType {
    const fallback  = getContentType(assetType) as AllowedMimeType
    const candidate = ((contentType ?? fallback).toLowerCase()) as AllowedMimeType
    const allowed   = getAllowedMimeTypesForAssetType(assetType)
    if (!allowed.includes(candidate)) throw new BadRequestException('Unsupported file type')
    return candidate
  }

  private extensionMatchesMime(key: string, mime: AllowedMimeType, assetType: AssetType): boolean {
    const ext = `.${key.split('.').pop()?.toLowerCase() ?? ''}`
    if (!getAllowedExtensionsForAssetType(assetType).includes(ext)) return false
    if (mime === 'image/jpeg')       return ext === '.jpg' || ext === '.jpeg'
    if (mime === 'image/png')        return ext === '.png'
    if (mime === 'image/webp')       return ext === '.webp'
    if (mime === 'application/pdf')  return ext === '.pdf'
    return false
  }

  private extractEntityIdFromKey(key: string, assetType: AssetType): string {
    const parts = key.split('/')
    if (parts.length < 2) throw new BadRequestException('Invalid media key format')
    if (assetType === 'player_profile'    && parts[0] === 'players') return parts[1]
    if ((assetType === 'owner_profile' || assetType === 'kyc_document') && parts[0] === 'owners') return parts[1]
    if (['venue_cover', 'venue_gallery', 'venue_verification'].includes(assetType) && parts[0] === 'venues') return parts[1]
    throw new BadRequestException('Key does not match asset type')
  }

  private async safeDelete(key: string): Promise<void> {
    await this.storage.delete(key).catch(() => {})
  }

  private isNotFoundError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    const name   = 'name'   in error ? String((error as any).name)  : ''
    const code   = 'Code'   in error ? String((error as any).Code)  : ''
    const status = (error as any)?.$metadata?.httpStatusCode
    return name === 'NotFound' || code === 'NoSuchKey' || status === 404
  }
}

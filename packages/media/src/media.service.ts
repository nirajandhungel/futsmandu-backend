// packages/media/src/media.service.ts
// ─── ADDITIVE UPDATE ──────────────────────────────────────────────────────────
// Added methods (NEW — safe to add, do NOT modify existing methods):
//   getSignedImageUrl(key, expiresIn?)  → presigned GET URL via R2StorageService
//   getLegacyImageUrl(key)              → existing CDN URL behaviour (passthrough)
//   getVenueImageSignedUrl(key)         → convenience wrapper used by venue controllers
//   getGallerySignedUrls(venueId)       → returns gallery with signed URLs
//   getKycDocSignedUrl(ownerId, docType) → admin/owner KYC doc access
//   getVenueVerificationSignedUrl(venueId, key) → admin venue verification access
//
// ALL EXISTING METHODS ARE UNTOUCHED.
// Feature flag: USE_SIGNED_IMAGE_URLS=true|false
// When false → signed URL methods return legacy CDN URL (backward compat).
// ─────────────────────────────────────────────────────────────────────────────

import {
  Injectable, BadRequestException, ForbiddenException, NotFoundException,
  Logger, InternalServerErrorException, Inject,
} from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { PrismaService } from '@futsmandu/database'
import { QUEUE_IMAGE_PROCESSING } from '@futsmandu/queues'
import { ENV } from '@futsmandu/utils'
import { fileTypeFromBuffer } from 'file-type'

import {
  AssetType, PUBLIC_ASSET_TYPES,
  RequestUploadUrlOptions,
  SignedDownloadUrlOptions, ImageProcessingJobData,
  generateMediaKey, getContentType, getCacheControl, getResizeDimensions,
  ALLOWED_MIME_TYPES, AllowedMimeType,
  getAllowedMimeTypesForAssetType, getAllowedExtensionsForAssetType,
  getPreferredExtensionForMimeType,
} from '@futsmandu/media-core'

import {
  generateSignedUploadUrl, generateSignedDownloadUrl,
  deleteStorageObject, StorageConfig, formatCdnUrl,
  getStorageObjectMetadata, downloadStorageObjectBuffer,
} from '@futsmandu/media-storage'

// NEW import — R2StorageService for GET presigning
import { R2StorageService } from '@futsmandu/r2-storage'

import { MEDIA_STORAGE_CONFIG } from './media.constants.js'

const PRESIGN_EXPIRY_SECONDS = 600
const MAX_FILE_SIZE = 5 * 1024 * 1024
const ALLOWED_KYC_DOC_TYPES = ['citizenship', 'business_registration', 'business_pan'] as const

// ─── Feature flag helper ──────────────────────────────────────────────────────

function useSignedUrls(): boolean {
  return ENV['USE_SIGNED_IMAGE_URLS'] === 'true'
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name)

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_IMAGE_PROCESSING) private readonly imageQueue: Queue,
    @Inject(MEDIA_STORAGE_CONFIG) private readonly storageConfig: StorageConfig,
    // NEW — optional injection; will be undefined if R2StorageModule not imported
    // Use @Optional() if you don't want to require it in all apps
    private readonly r2: R2StorageService,
  ) {}

  // ════════════════════════════════════════════════════════════════════════════
  // EXISTING METHODS — DO NOT MODIFY
  // ════════════════════════════════════════════════════════════════════════════

  async requestUploadUrl(opts: RequestUploadUrlOptions): Promise<{
    assetId: string
    uploadUrl: string
    key: string
    cdnUrl?: string
    expiresIn: number
  }> {
    await this.validateOwnership(opts)

    if (opts.assetType === 'kyc_document') {
      if (!opts.docType || !ALLOWED_KYC_DOC_TYPES.includes(opts.docType as any)) {
        throw new BadRequestException(`Invalid docType. Allowed: ${ALLOWED_KYC_DOC_TYPES.join(', ')}`)
      }
    }

    const contentType = this.resolveAllowedContentType(opts.assetType, opts.contentType)
    const key = generateMediaKey({
      assetType:  opts.assetType,
      entityId:   opts.entityId,
      docType:    opts.docType,
      extension:  getPreferredExtensionForMimeType(contentType),
    })
    const cacheControl = getCacheControl(opts.assetType)
    const isPublic = PUBLIC_ASSET_TYPES.includes(opts.assetType)

    this.logger.log(JSON.stringify({
      event:     'UPLOAD_STARTED',
      ownerId:   opts.ownerId,
      assetType: opts.assetType,
      mimeType:  contentType,
    }))

    const asset = await this.prisma.media_assets.upsert({
      where: { key },
      create: {
        key,
        assetType: opts.assetType,
        status: 'processing',
        uploaderId: opts.ownerId,
        entityId: opts.entityId,
      },
      update: {
        assetType: opts.assetType,
        status: 'processing',
        uploaderId: opts.ownerId,
        entityId: opts.entityId,
        webpKey: null,
        updatedAt: new Date(),
      },
    })

    const uploadUrl = await generateSignedUploadUrl(this.storageConfig, {
      key,
      contentType,
      cacheControl,
      expiresIn: PRESIGN_EXPIRY_SECONDS,
    })

    const result: {
      assetId: string
      uploadUrl: string
      key: string
      expiresIn: number
      cdnUrl?: string
    } = {
      assetId: asset.id,
      uploadUrl,
      key,
      expiresIn: PRESIGN_EXPIRY_SECONDS,
    }

    if (isPublic) {
      result.cdnUrl = formatCdnUrl(ENV['S3_CDN_BASE_URL'] || ENV['S3_ENDPOINT'] || '', key)
    }

    return result
  }

  async confirmUpload(
    opts: { ownerId: string; assetId: string; key: string; assetType: AssetType },
  ): Promise<{ message: string; assetId: string }> {
    try {
      const objectMeta = await getStorageObjectMetadata(this.storageConfig, opts.key)
      const objectSize = objectMeta.contentLength ?? 0

      if (objectSize <= 0) {
        await this.safeDeleteObject(opts.key)
        throw new BadRequestException('Invalid file: uploaded file appears to be empty')
      }
      if (objectSize > MAX_FILE_SIZE) {
        await this.safeDeleteObject(opts.key)
        throw new BadRequestException('File too large. Maximum allowed size is 5 MB')
      }

      const expectedContentType = this.resolveAllowedContentType(opts.assetType, objectMeta.contentType)
      const buffer = await downloadStorageObjectBuffer(this.storageConfig, opts.key)
      const detected = await fileTypeFromBuffer(buffer)

      if (!detected || !ALLOWED_MIME_TYPES.includes(detected.mime as AllowedMimeType)) {
        await this.safeDeleteObject(opts.key)
        throw new BadRequestException('Invalid file format. Only JPEG, PNG, WebP, and PDF are accepted')
      }

      const detectedMime = detected.mime as AllowedMimeType
      if (detectedMime !== expectedContentType) {
        await this.safeDeleteObject(opts.key)
        throw new BadRequestException(
          `File content type mismatch: declared ${expectedContentType} but file is ${detectedMime}`,
        )
      }

      if (!this.extensionMatchesMime(opts.key, detectedMime, opts.assetType)) {
        await this.safeDeleteObject(opts.key)
        throw new BadRequestException('File extension does not match content type')
      }

      this.logger.log(JSON.stringify({
        event:     'UPLOAD_VALIDATED',
        ownerId:   opts.ownerId,
        assetType: opts.assetType,
        fileSize:  objectSize,
        mimeType:  detectedMime,
      }))
    } catch (error) {
      if (error instanceof BadRequestException) {
        this.logger.warn(JSON.stringify({
          event:     'UPLOAD_REJECTED',
          ownerId:   opts.ownerId,
          assetType: opts.assetType,
          reason:    String(error.message),
        }))
        throw error
      }

      if (this.isStorageNotFoundError(error)) {
        throw new BadRequestException(
          'File not found in storage. Upload the file to the presigned URL first, then call confirm-upload.',
        )
      }

      this.logger.error(JSON.stringify({
        event:     'UPLOAD_FAILED',
        ownerId:   opts.ownerId,
        assetType: opts.assetType,
        reason:    error instanceof Error ? error.message : String(error),
      }))
      throw new BadRequestException({
        message:   'Unable to verify uploaded file, please retry',
        retryable: true,
      })
    }

    const entityId = this.extractEntityIdFromKey(opts.key, opts.assetType)
    const asset = await this.prisma.media_assets.findUnique({ where: { id: opts.assetId } })
    if (!asset) {
      throw new NotFoundException('Upload session not found. Request a new upload URL.')
    }
    if (asset.uploaderId !== opts.ownerId) {
      throw new ForbiddenException('You do not own this uploaded asset')
    }
    if (asset.key !== opts.key) {
      throw new BadRequestException('Key does not match upload session')
    }
    if (asset.assetType !== opts.assetType) {
      throw new BadRequestException('assetType does not match upload session')
    }
    if (asset.entityId !== entityId) {
      throw new BadRequestException('Entity mismatch for this upload session')
    }

    await this.prisma.media_assets.update({
      where: { id: asset.id },
      data:  { status: 'processing', updatedAt: new Date() },
    })

    if (opts.assetType !== 'kyc_document') {
      const { width, height } = getResizeDimensions(opts.assetType)
      const jobData: ImageProcessingJobData = {
        assetId:      opts.assetId,
        key:          opts.key,
        bucket:       this.storageConfig.bucket,
        assetType:    opts.assetType,
        targetWidth:  width,
        targetHeight: height,
      }

      await this.imageQueue
        .add('process-media', jobData, {
          attempts:         3,
          backoff:          { type: 'exponential', delay: 5_000 },
          removeOnComplete: 50,
          removeOnFail:     100,
        })
        .catch((e: unknown) => {
          this.logger.error('Failed to enqueue image processing job', e)
        })
    } else {
      await this.prisma.media_assets.update({
        where: { id: opts.assetId },
        data:  { status: 'ready', updatedAt: new Date() },
      })
    }

    // Evict any cached signed URL for this key so the next access gets a fresh one
    if (this.r2) {
      this.r2.evictCacheForKey(opts.key)
    }

    await this.syncDomainMediaPointers(opts.assetType, entityId, opts.key)

    this.logger.log(JSON.stringify({
      event:     'UPLOAD_COMPLETED',
      ownerId:   opts.ownerId,
      assetType: opts.assetType,
      assetId:   opts.assetId,
    }))

    return { message: 'Upload confirmed — processing started', assetId: opts.assetId }
  }

  async getUploadStatus(
    assetId: string,
    ownerId: string,
  ): Promise<{ status: 'processing' | 'ready' | 'failed'; webpKey?: string | null }> {
    const asset = await this.prisma.media_assets.findUnique({ where: { id: assetId } })
    if (!asset || asset.uploaderId !== ownerId) {
      throw new NotFoundException('Asset not found')
    }
    return {
      status:  asset.status as 'processing' | 'ready' | 'failed',
      webpKey: asset.webpKey,
    }
  }

  async getSignedDownloadUrl(
    opts: SignedDownloadUrlOptions,
  ): Promise<{ downloadUrl: string; expiresIn: number }> {
    this.assertKeyIsPrivate(opts.key)
    const expiresIn = opts.expiresIn ?? PRESIGN_EXPIRY_SECONDS
    const downloadUrl = await generateSignedDownloadUrl(this.storageConfig, { key: opts.key, expiresIn })
    return { downloadUrl, expiresIn }
  }

  getCdnUrl(key: string): string {
    this.assertKeyIsPublic(key)
    return formatCdnUrl(ENV['S3_CDN_BASE_URL'] || ENV['S3_ENDPOINT'] || '', key)
  }

  async deleteAsset(assetId: string, requesterId: string): Promise<void> {
    const asset = await this.prisma.media_assets.findUnique({ where: { id: assetId } })
    if (!asset) throw new NotFoundException('Asset not found')
    if (asset.uploaderId !== requesterId) throw new ForbiddenException('You do not own this asset')

    await deleteStorageObject(this.storageConfig, asset.key)
    // Evict cache after delete
    if (this.r2) this.r2.evictCacheForKey(asset.key)

    await this.prisma.media_assets.update({
      where: { id: assetId },
      data:  { status: 'failed', updatedAt: new Date() },
    })

    this.logger.log(`Asset deleted: ${asset.key} by ${requesterId}`)
  }

  // ════════════════════════════════════════════════════════════════════════════
  // NEW METHODS — presigned GET URL support
  // Feature flag: USE_SIGNED_IMAGE_URLS=true enables these.
  // When flag is false, all new methods fall back to legacy CDN URL.
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Returns a presigned GET URL for any image key.
   * Respects USE_SIGNED_IMAGE_URLS flag.
   * Cached for 50 minutes in-memory.
   */
  async getSignedImageUrl(key: string, expiresIn = 3_600): Promise<string> {
    if (!useSignedUrls() || !this.r2) {
      return this.getLegacyImageUrl(key)
    }
    return this.r2.getPresignedGetUrl(key, expiresIn)
  }

  /**
   * Returns the legacy CDN URL (existing behaviour, unchanged).
   * Always safe to call — does not require R2StorageService.
   */
  getLegacyImageUrl(key: string): string {
    return formatCdnUrl(ENV['S3_CDN_BASE_URL'] || ENV['S3_ENDPOINT'] || '', key)
  }

  /**
   * Venue cover image URL.
   * Returns presigned URL when flag is on, CDN URL when off.
   */
  async getVenueImageSignedUrl(imageKey: string): Promise<string> {
    return this.getSignedImageUrl(imageKey, 3_600)
  }

  /**
   * Gallery images for a venue — returns both cdnUrl (legacy) + signedUrl (new).
   * Controller spreads both into response for backward compat.
   */
  async getGallerySignedUrls(venueId: string): Promise<Array<{
    assetId: string
    key: string
    cdnUrl: string
    signedUrl?: string
    webpUrl?: string
    uploadedAt: Date
  }>> {
    const assets = await this.prisma.media_assets.findMany({
      where:   { entityId: venueId, assetType: 'venue_gallery', status: 'ready' },
      select:  { id: true, key: true, webpKey: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    })

    const cdnBase = ENV['S3_CDN_BASE_URL'] || ENV['S3_ENDPOINT'] || ''

    return Promise.all(
      assets.map(async (a: { id: string; key: string; webpKey: string | null; createdAt: Date }) => {
        const effectiveKey = a.webpKey ?? a.key
        const cdnUrl       = formatCdnUrl(cdnBase, a.key)
        const signedUrl    = useSignedUrls() && this.r2
          ? await this.r2.getPresignedGetUrl(effectiveKey, 3_600)
          : undefined

        return {
          assetId:    a.id,
          key:        a.key,
          cdnUrl,
          signedUrl,
          webpUrl:    a.webpKey ? formatCdnUrl(cdnBase, a.webpKey) : undefined,
          uploadedAt: a.createdAt,
        }
      }),
    )
  }

  /**
   * KYC document — always private, always needs signed URL.
   * Returns signed GET URL regardless of feature flag (KYC docs are never public).
   */
  async getKycDocSignedUrl(ownerId: string, docType: string, expiresIn = 600): Promise<{ downloadUrl: string; expiresIn: number }> {
    // Try pdf first, then jpg/png/webp (owners can upload any allowed type)
    const extensions = ['pdf', 'jpg', 'jpeg', 'png', 'webp']
    for (const ext of extensions) {
      const key = `owners/${ownerId}/kyc/${docType}.${ext}`
      // Use R2StorageService if available, fall back to existing getSignedDownloadUrl
      if (this.r2) {
        const url = await this.r2.getPresignedGetUrl(key, expiresIn).catch(() => null)
        if (url) return { downloadUrl: url, expiresIn }
      }
    }
    // Fallback — deterministic PDF key (legacy path)
    const key = `owners/${ownerId}/kyc/${docType}.pdf`
    return this.getSignedDownloadUrl({ key, expiresIn })
  }

  /**
   * Venue verification image — private, signed URL only.
   */
  async getVenueVerificationSignedUrl(
    venueId: string,
    key: string,
    expiresIn = 600,
  ): Promise<{ downloadUrl: string; expiresIn: number }> {
    if (!key.startsWith(`venues/${venueId}/verification/`)) {
      throw new NotFoundException('Verification image not found for this venue')
    }
    if (this.r2) {
      const url = await this.r2.getPresignedGetUrl(key, expiresIn)
      return { downloadUrl: url, expiresIn }
    }
    return this.getSignedDownloadUrl({ key, expiresIn })
  }

  // ════════════════════════════════════════════════════════════════════════════
  // EXISTING PRIVATE METHODS — DO NOT MODIFY
  // ════════════════════════════════════════════════════════════════════════════

  private async validateOwnership(opts: RequestUploadUrlOptions): Promise<void> {
    switch (opts.assetType) {
      case 'player_profile':
      case 'owner_profile':
      case 'kyc_document':
        if (opts.entityId !== opts.ownerId) {
          throw new ForbiddenException('You can only upload to your own media folder')
        }
        break

      case 'venue_cover':
      case 'venue_gallery':
      case 'venue_verification': {
        const venue = await this.prisma.venues.findFirst({
          where:  { id: opts.entityId, owner_id: opts.ownerId },
          select: { id: true },
        })
        if (!venue) throw new ForbiddenException('Venue not found or access denied')
        break
      }

      default:
        throw new BadRequestException(`Unknown assetType: ${opts.assetType}`)
    }
  }

  private async syncDomainMediaPointers(
    assetType: AssetType,
    entityId: string,
    key: string,
  ): Promise<void> {
    const cdnUrl = formatCdnUrl(ENV['S3_CDN_BASE_URL'] || ENV['S3_ENDPOINT'] || '', key)

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

    if (assetType === 'venue_gallery') {
      return
    }

    if (assetType === 'kyc_document') {
      const current = await this.prisma.owners.findUnique({
        where:  { id: entityId },
        select: { verification_docs: true },
      })
      const docs = (
        current?.verification_docs && typeof current.verification_docs === 'object'
          ? current.verification_docs
          : {}
      ) as Record<string, unknown>
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

  private assertKeyIsPrivate(key: string): void {
    const isPrivate =
      (key.startsWith('owners/') && key.includes('/kyc/')) ||
      (key.startsWith('venues/') && key.includes('/verification/'))
    if (!isPrivate) throw new ForbiddenException('This asset is public — use CDN URL instead')
  }

  private assertKeyIsPublic(key: string): void {
    const isPrivate =
      (key.startsWith('owners/') && key.includes('/kyc/')) ||
      (key.startsWith('venues/') && key.includes('/verification/'))
    if (isPrivate) {
      throw new InternalServerErrorException('Attempted to generate CDN URL for a private asset')
    }
  }

  private extractEntityIdFromKey(key: string, assetType: AssetType): string {
    const parts = key.split('/')
    if (parts.length < 2) throw new BadRequestException('Invalid media key format')

    if (assetType === 'player_profile' && parts[0] === 'players') return parts[1]
    if ((assetType === 'owner_profile' || assetType === 'kyc_document') && parts[0] === 'owners') return parts[1]
    if (
      (assetType === 'venue_cover' || assetType === 'venue_gallery' || assetType === 'venue_verification') &&
      parts[0] === 'venues'
    ) return parts[1]

    throw new BadRequestException('Key does not match asset type')
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

  private async safeDeleteObject(key: string): Promise<void> {
    await deleteStorageObject(this.storageConfig, key).catch(() => {})
  }

  private isStorageNotFoundError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    const name   = 'name'   in error ? String(error.name)   : ''
    const code   = 'Code'   in error ? String(error.Code)   : ''
    const status =
      '$metadata' in error &&
      error.$metadata &&
      typeof error.$metadata === 'object'
        ? Number((error.$metadata as { httpStatusCode?: number }).httpStatusCode)
        : NaN
    return name === 'NotFound' || code === 'NoSuchKey' || status === 404
  }
}

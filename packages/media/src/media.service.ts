import { Injectable, BadRequestException, ForbiddenException, NotFoundException, Logger, InternalServerErrorException, Inject } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { PrismaService } from '@futsmandu/database'
import { QUEUE_IMAGE_PROCESSING } from '@futsmandu/queues'
import { ENV } from '@futsmandu/utils'
import { fileTypeFromBuffer } from 'file-type'

import {
  AssetType, PUBLIC_ASSET_TYPES,
  RequestUploadUrlOptions, UploadUrlResult, ConfirmUploadOptions,
  SignedDownloadUrlOptions, ImageProcessingJobData, generateMediaKey,
  getContentType, getCacheControl, getResizeDimensions, ALLOWED_MIME_TYPES,
  AllowedMimeType, getAllowedMimeTypesForAssetType, getAllowedExtensionsForAssetType, getPreferredExtensionForMimeType
} from '@futsmandu/media-core'

import {
  generateSignedUploadUrl, generateSignedDownloadUrl,
  deleteStorageObject, StorageConfig, formatCdnUrl, getStorageObjectMetadata, downloadStorageObjectBuffer
} from '@futsmandu/media-storage'

import { MEDIA_STORAGE_CONFIG } from './media.constants.js'

const PRESIGN_EXPIRY_SECONDS = 600
const MAX_FILE_SIZE = 5 * 1024 * 1024
const ALLOWED_KYC_DOC_TYPES = ['citizenship', 'business_registration', 'business_pan'] as const

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name)

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_IMAGE_PROCESSING) private readonly imageQueue: Queue,
    @Inject(MEDIA_STORAGE_CONFIG) private readonly storageConfig: StorageConfig,
  ) {}

  async requestUploadUrl(opts: RequestUploadUrlOptions): Promise<UploadUrlResult> {
    await this.validateOwnership(opts)

    if (opts.assetType === 'kyc_document') {
      if (!opts.docType || !ALLOWED_KYC_DOC_TYPES.includes(opts.docType as any)) {
        throw new BadRequestException(`Invalid docType. Allowed: ${ALLOWED_KYC_DOC_TYPES.join(', ')}`)
      }
    }

    const contentType = this.resolveAllowedContentType(opts.assetType, opts.contentType)
    const key = generateMediaKey({
      assetType: opts.assetType,
      entityId: opts.entityId,
      docType: opts.docType,
      extension: getPreferredExtensionForMimeType(contentType),
    })
    const cacheControl = getCacheControl(opts.assetType)
    const isPublic = PUBLIC_ASSET_TYPES.includes(opts.assetType)

    this.logger.log(JSON.stringify({
      event: 'UPLOAD_STARTED',
      ownerId: opts.ownerId,
      assetType: opts.assetType,
      mimeType: contentType,
      fileSize: null,
    }))

    const uploadUrl = await generateSignedUploadUrl(this.storageConfig, {
      key,
      contentType,
      cacheControl,
      expiresIn: PRESIGN_EXPIRY_SECONDS
    })

    const result: UploadUrlResult = {
      uploadUrl,
      key,
      expiresIn: PRESIGN_EXPIRY_SECONDS,
    }

    if (isPublic) {
      result.cdnUrl = formatCdnUrl(ENV['S3_CDN_BASE_URL'] || ENV['S3_ENDPOINT'] || '', key)
    }

    return result
  }

  async confirmUpload(opts: ConfirmUploadOptions & { ownerId: string }): Promise<{ message: string }> {
    try {
      const objectMeta = await getStorageObjectMetadata(this.storageConfig, opts.key)
      const objectSize = objectMeta.contentLength ?? 0
      if (objectSize <= 0) {
        await this.safeDeleteObject(opts.key)
        throw new BadRequestException('Invalid file format')
      }
      if (objectSize > MAX_FILE_SIZE) {
        await this.safeDeleteObject(opts.key)
        throw new BadRequestException('File is too large. Max allowed size is 5MB')
      }

      const expectedContentType = this.resolveAllowedContentType(opts.assetType, objectMeta.contentType)
      const buffer = await downloadStorageObjectBuffer(this.storageConfig, opts.key)
      const detected = await fileTypeFromBuffer(buffer)
      if (!detected || !ALLOWED_MIME_TYPES.includes(detected.mime as AllowedMimeType)) {
        await this.safeDeleteObject(opts.key)
        throw new BadRequestException('Invalid file format')
      }

      const detectedMime = detected.mime as AllowedMimeType
      if (detectedMime !== expectedContentType) {
        await this.safeDeleteObject(opts.key)
        throw new BadRequestException('Invalid file format')
      }

      if (!this.extensionMatchesMime(opts.key, detectedMime, opts.assetType)) {
        await this.safeDeleteObject(opts.key)
        throw new BadRequestException('Invalid file format')
      }

      this.logger.log(JSON.stringify({
        event: 'UPLOAD_VALIDATED',
        ownerId: opts.ownerId,
        assetType: opts.assetType,
        fileSize: objectSize,
        mimeType: detectedMime,
      }))
    } catch (error) {
      if (error instanceof BadRequestException) {
        this.logger.warn(JSON.stringify({
          event: 'UPLOAD_REJECTED',
          ownerId: opts.ownerId,
          assetType: opts.assetType,
          reason: String(error),
        }))
        throw error
      }

      if (this.isStorageNotFoundError(error)) {
        throw new BadRequestException('Object not found in storage. Upload the file first, then call confirm-upload.')
      }

      this.logger.error(JSON.stringify({
        event: 'UPLOAD_FAILED',
        ownerId: opts.ownerId,
        assetType: opts.assetType,
        reason: error instanceof Error ? error.message : String(error),
      }))
      throw new BadRequestException({
        message: 'Unable to verify uploaded file, please retry',
        retryable: true,
      })
    }

    const entityId = this.extractEntityIdFromKey(opts.key, opts.assetType)
    const existing = await this.prisma.media_assets.findUnique({ where: { key: opts.key } })

    if (existing && existing.uploaderId !== opts.ownerId) {
      throw new ForbiddenException('You do not own this uploaded asset')
    }

    const asset = existing
      ? await this.prisma.media_assets.update({
          where: { id: existing.id },
          data: { status: 'processing', updatedAt: new Date() },
        })
      : await this.prisma.media_assets.create({
          data: {
            key: opts.key,
            assetType: opts.assetType,
            status: 'processing',
            uploaderId: opts.ownerId,
            entityId,
          },
        })

    if (opts.assetType !== 'kyc_document') {
      const { width, height } = getResizeDimensions(opts.assetType)
      const jobData: ImageProcessingJobData = {
        assetId: asset.id,
        key: opts.key,
        bucket: this.storageConfig.bucket,
        assetType: opts.assetType,
        targetWidth: width,
        targetHeight: height,
      }

      await this.imageQueue
        .add('process-media', jobData, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: 50,
          removeOnFail: 100,
        })
        .catch((e: unknown) => {
          this.logger.error('Failed to enqueue image processing job', e)
        })
    } else {
      await this.prisma.media_assets.update({
        where: { id: asset.id },
        data: { status: 'ready', updatedAt: new Date() },
      })
    }

    await this.syncDomainMediaPointers(opts.assetType, entityId, opts.key)

    this.logger.log(JSON.stringify({
      event: 'UPLOAD_COMPLETED',
      ownerId: opts.ownerId,
      assetType: opts.assetType,
      fileSize: null,
      mimeType: null,
    }))

    return { message: 'Upload confirmed — processing started' }
  }

  async getUploadStatus(assetId: string, ownerId: string): Promise<{ status: 'processing' | 'ready' | 'failed' }> {
    const asset = await this.prisma.media_assets.findUnique({ where: { id: assetId } })
    if (!asset || asset.uploaderId !== ownerId) {
      throw new NotFoundException('Asset not found')
    }
    return { status: asset.status as 'processing' | 'ready' | 'failed' }
  }

  async getSignedDownloadUrl(opts: SignedDownloadUrlOptions): Promise<{ downloadUrl: string; expiresIn: number }> {
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
    const asset = await this.prisma.media_assets.findUnique({
      where: { id: assetId },
    })
    if (!asset) throw new NotFoundException('Asset not found')
    if (asset.uploaderId !== requesterId) {
      throw new ForbiddenException('You do not own this asset')
    }

    await deleteStorageObject(this.storageConfig, asset.key)

    await this.prisma.media_assets.update({
      where: { id: assetId },
      data: { status: 'failed', updatedAt: new Date() },
    })

    this.logger.log(`Asset deleted: ${asset.key} by ${requesterId}`)
  }

  private async validateOwnership(opts: RequestUploadUrlOptions): Promise<void> {
    switch (opts.assetType) {
      case 'player_profile':
      case 'owner_profile':
      case 'kyc_document':
        if (opts.entityId !== opts.ownerId) throw new ForbiddenException('You can only upload to your own media folder')
        break

      case 'venue_cover':
      case 'venue_gallery':
      case 'venue_verification': {
        const venue = await this.prisma.venues.findFirst({
          where: { id: opts.entityId, owner_id: opts.ownerId },
          select: { id: true },
        })
        if (!venue) throw new ForbiddenException('Venue not found or access denied')
        break
      }

      default:
        throw new BadRequestException(`Unknown assetType: ${opts.assetType}`)
    }
  }

  private assertKeyIsPrivate(key: string): void {
    const isPrivate = key.startsWith('owners/') && key.includes('/kyc/') ||
                      key.startsWith('venues/') && key.includes('/verification/')
    if (!isPrivate) {
      throw new ForbiddenException('This asset is public — use CDN URL instead')
    }
  }

  private assertKeyIsPublic(key: string): void {
    const isPrivate = (key.startsWith('owners/') && key.includes('/kyc/')) ||
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
    if ((assetType === 'venue_cover' || assetType === 'venue_gallery' || assetType === 'venue_verification') && parts[0] === 'venues') return parts[1]

    throw new BadRequestException('Key does not match asset type')
  }

  private async syncDomainMediaPointers(assetType: AssetType, entityId: string, key: string): Promise<void> {
    const cdnUrl = formatCdnUrl(ENV['S3_CDN_BASE_URL'] || ENV['S3_ENDPOINT'] || '', key)

    if (assetType === 'player_profile') {
      await this.prisma.users.update({
        where: { id: entityId },
        data: { profile_image_url: cdnUrl, updated_at: new Date() },
      }).catch(() => {})
      return
    }

    if (assetType === 'owner_profile') {
      await this.prisma.owners.update({
        where: { id: entityId },
        data: { profile_image_url: cdnUrl, updated_at: new Date() },
      }).catch(() => {})
      return
    }

    if (assetType === 'venue_cover') {
      await this.prisma.venues.update({
        where: { id: entityId },
        data: { cover_image_url: cdnUrl, updated_at: new Date() },
      }).catch(() => {})
      return
    }

    if (assetType === 'kyc_document') {
      const current = await this.prisma.owners.findUnique({
        where: { id: entityId },
        select: { verification_docs: true },
      })
      const docs = (current?.verification_docs && typeof current.verification_docs === 'object'
        ? current.verification_docs
        : {}) as Record<string, unknown>
      const docType = key.split('/').pop()?.replace(/\.[^/.]+$/, '')
      if (!docType) return
      await this.prisma.owners.update({
        where: { id: entityId },
        data: {
          verification_docs: { ...docs, [docType]: key } as any,
          updated_at: new Date(),
        },
      }).catch(() => {})
    }
  }

  private resolveAllowedContentType(assetType: AssetType, contentType?: string): AllowedMimeType {
    const fallback = getContentType(assetType) as AllowedMimeType
    const candidate = (contentType ?? fallback).toLowerCase() as AllowedMimeType
    const allowedForAssetType = getAllowedMimeTypesForAssetType(assetType)
    if (!allowedForAssetType.includes(candidate)) {
      throw new BadRequestException('Unsupported file type')
    }
    return candidate
  }

  private extensionMatchesMime(key: string, mime: AllowedMimeType, assetType: AssetType): boolean {
    const ext = `.${key.split('.').pop()?.toLowerCase() ?? ''}`
    if (!getAllowedExtensionsForAssetType(assetType).includes(ext)) return false
    if (mime === 'image/jpeg') return ext === '.jpg' || ext === '.jpeg'
    if (mime === 'image/png') return ext === '.png'
    if (mime === 'image/webp') return ext === '.webp'
    if (mime === 'application/pdf') return ext === '.pdf'
    return false
  }

  private async safeDeleteObject(key: string): Promise<void> {
    await deleteStorageObject(this.storageConfig, key).catch(() => {})
  }

  private isStorageNotFoundError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    const name = 'name' in error ? String(error.name) : ''
    const code = 'Code' in error ? String(error.Code) : ''
    const status = '$metadata' in error && error.$metadata && typeof error.$metadata === 'object'
      ? Number((error.$metadata as { httpStatusCode?: number }).httpStatusCode)
      : NaN

    return name === 'NotFound' || code === 'NoSuchKey' || status === 404
  }
}
import { Injectable, BadRequestException, ForbiddenException, NotFoundException, Logger, InternalServerErrorException, Inject } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { PrismaService } from '@futsmandu/database'
import { QUEUE_IMAGE_PROCESSING } from '@futsmandu/queues'
import { ENV } from '@futsmandu/utils'

import {
  AssetType, KycDocType, PUBLIC_ASSET_TYPES,
  RequestUploadUrlOptions, UploadUrlResult, ConfirmUploadOptions,
  SignedDownloadUrlOptions, ImageProcessingJobData, generateMediaKey,
  getContentType, getCacheControl, getResizeDimensions
} from '@futsmandu/media-core'

import {
  generateSignedUploadUrl, generateSignedDownloadUrl,
  deleteStorageObject, StorageConfig, formatCdnUrl
} from '@futsmandu/media-storage'

import { MEDIA_STORAGE_CONFIG } from './media.constants.js'

const PRESIGN_EXPIRY_SECONDS = 600
const ALLOWED_KYC_DOC_TYPES: KycDocType[] = ['nid_front', 'nid_back', 'business_registration', 'tax_certificate']

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

    const key = generateMediaKey({ assetType: opts.assetType, entityId: opts.entityId, docType: opts.docType })
    const contentType = getContentType(opts.assetType)
    const cacheControl = getCacheControl(opts.assetType)
    const isPublic = PUBLIC_ASSET_TYPES.includes(opts.assetType)

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
      const probeUrl = await generateSignedDownloadUrl(this.storageConfig, { key: opts.key, expiresIn: 30 })
      const probe = await fetch(probeUrl, { method: 'HEAD' })
      if (!probe.ok) throw new Error(`Storage probe failed: ${probe.status}`)
    } catch {
      throw new BadRequestException('Object not found in storage. Upload the file first, then call confirm-upload.')
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

    return { message: 'Upload confirmed — processing started' }
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
      const docType = key.split('/').pop()?.replace('.pdf', '')
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
}
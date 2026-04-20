// packages/media/src/media.service.ts

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common'

import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'

import { PrismaService } from '@futsmandu/database'
import { StorageService } from '@futsmandu/media-storage'
import { RedisService } from '@futsmandu/redis'

import {
  generateMediaKey,
  getCacheControl,
  getResizeDimensions,
  getAllowedMimeTypesForAssetType,
  getPreferredExtensionForMimeType,
  predictWebpKey,
  predictThumbKey,
} from '@futsmandu/media-core'

import type {
  RequestUploadUrlOptions,
  UploadUrlResult,
  ConfirmUploadOptions,
  ConfirmUploadResult,
  GalleryItem,
  UploadStatusResult,
  AssetType,
} from '@futsmandu/media-core'

import { QUEUE_IMAGE_PROCESSING } from '@futsmandu/queues'
import { ENV } from '@futsmandu/utils'

/* ───────────────── Constants ───────────────── */

const MAGIC_BYTES: Record<string, string> = {
  ffd8ff: 'image/jpeg',
  '89504e47': 'image/png',
  '52494646': 'image/webp',
  '25504446': 'application/pdf',
}

const STATUS_CACHE_TTL = 5
const GALLERY_CACHE_TTL = 120

/* ───────────────── Types ───────────────── */

type GalleryAsset = {
  id: string
  key: string
  webpKey: string | null
  thumbKey: string | null
  createdAt: Date
  status: string
}

/* ───────────────── Service ───────────────── */

@Injectable()
export class MediaService {

  private readonly logger = new Logger(MediaService.name)
  private readonly cdnBase: string

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly redis: RedisService,

    @InjectQueue(QUEUE_IMAGE_PROCESSING)
    private readonly imgQueue: Queue,
  ) {

    this.cdnBase =
      (
        ENV['S3_CDN_BASE_URL'] ||
        ENV['S3_ENDPOINT'] ||
        ''
      ).replace(/\/+$/, '')
  }

  /* ───────────────── Step 1 — Upload URL ───────────────── */

  async requestUploadUrl(
    opts: RequestUploadUrlOptions,
  ): Promise<UploadUrlResult> {

    await this.validateOwnership(opts)

    const allowedMimes =
      getAllowedMimeTypesForAssetType(
        opts.assetType,
      )

    const contentType =
      opts.contentType &&
        (allowedMimes as readonly string[]).includes(
          opts.contentType,
        )
        ? opts.contentType
        : allowedMimes[0]

    const ext =
      getPreferredExtensionForMimeType(
        contentType as Parameters<typeof getPreferredExtensionForMimeType>[0],
      )

    const key =
      generateMediaKey({
        assetType: opts.assetType,
        entityId: opts.entityId,
        docType: opts.docType,
        extension: ext,
      })

    const cacheControlStr = getCacheControl(opts.assetType);
    const [uploadUrl, assetRow] =
      await Promise.all([

        this.storage.presignUpload({
          key,
          contentType,
          cacheControl: cacheControlStr,
          expiresIn: 600,
        }),

        this.prisma.media_assets.upsert({
          where: { file_key: key },
          create: {
            file_key: key,
            asset_type: opts.assetType === 'kyc_document'
              ? (opts.docType === 'business_registration' ? 'OWNER_BUSINESS_REGISTRATION' : opts.docType === 'business_pan' ? 'OWNER_PAN' : 'OWNER_CITIZENSHIP')
              : opts.assetType === 'player_profile' ? 'USER_AVATAR'
                : opts.assetType === 'owner_profile' ? 'OWNER_AVATAR'
                  : opts.assetType === 'venue_cover' ? 'VENUE_COVER'
                    : opts.assetType === 'venue_gallery' ? 'VENUE_GALLERY'
                      : 'SYSTEM',
            status: 'pending',
            uploader_id: opts.ownerId,
            uploader_type: opts.assetType === 'player_profile' ? 'USER' : 'OWNER',
            metadata: { entityId: opts.entityId, originalAssetType: opts.assetType }
          },
          update: {
            status: 'pending',
            uploader_id: opts.ownerId,
            uploader_type: opts.assetType === 'player_profile' ? 'USER' : 'OWNER',
            metadata: { entityId: opts.entityId, originalAssetType: opts.assetType },
            updated_at: new Date(),
          },
          select: { id: true },
        }),
      ])

    const result: UploadUrlResult = {
      assetId: assetRow.id,
      uploadUrl,
      key,
      requiredHeaders: {
        'Content-Type': contentType,
        'Cache-Control': cacheControlStr,
      },
      expiresIn: 600,
    }

    const isPublic =
      !['kyc_document', 'venue_verification']
        .includes(opts.assetType)

    if (isPublic) {

      result.cdnUrl =
        this.storage.cdnUrl(
          this.cdnBase,
          key,
        )

      result.webpKey =
        predictWebpKey(key)
    }

    return result
  }

  /* ───────────────── Step 2 — Confirm Upload ───────────────── */

  async confirmUpload(
    opts: ConfirmUploadOptions,
  ): Promise<ConfirmUploadResult> {

    const asset =
      await this.prisma.media_assets.findFirst({
        where: {
          id: opts.assetId,
          uploader_id: opts.ownerId,
        },

        select: {
          id: true,
          status: true,
          file_key: true,
        },
      })

    if (!asset)
      throw new NotFoundException(
        'Asset not found',
      )

    if (asset.file_key !== opts.key) {
      throw new BadRequestException(
        'Key mismatch',
      )
    }

    if (asset.status !== 'pending') {

      return {
        message: 'Already confirmed',
        assetId: asset.id,

        cdnUrl:
          this.storage.cdnUrl(
            this.cdnBase,
            asset.file_key,
          ),

        webpKey:
          predictWebpKey(asset.file_key),

        thumbKey:
          predictThumbKey(asset.file_key),

        status: asset.status as any,
      }
    }

    /* Validate magic bytes */

    try {

      const header =
        await this.storage.downloadRange(
          opts.key,
          0,
          7,
        )

      const hex =
        header.toString('hex')

      const detected =
        Object.entries(MAGIC_BYTES)
          .find(([magic]) =>
            hex.startsWith(magic),
          )

      if (!detected) {

        await this.prisma.media_assets.update({
          where: { id: opts.assetId },
          data: { status: 'failed' },
        })

        throw new BadRequestException(
          'Unsupported file type',
        )
      }

    } catch (err) {

      if (
        err instanceof BadRequestException
      ) throw err

      this.logger.warn(
        `[${opts.assetId}] Magic check failed — continuing`,
      )
    }

    const { width, height } =
      getResizeDimensions(
        opts.assetType,
      )

    const [updatedAsset] =
      await Promise.all([

        this.prisma.media_assets.update({
          where: { id: opts.assetId },

          data: {
            status: 'processing',
            updated_at: new Date(),
          },

          select: {
            id: true,
            file_key: true,
          },
        }),

        this.imgQueue.add(
          'process-media',
          {
            assetId: opts.assetId,
            key: opts.key,
            bucket: ENV['S3_BUCKET'],
            assetType: opts.assetType,
            targetWidth: width,
            targetHeight: height,
          },
          {
            priority:
              opts.assetType.startsWith(
                'venue',
              )
                ? 1
                : 5,

            attempts: 3,

            backoff: {
              type: 'exponential',
              delay: 2000,
            },

            removeOnComplete: {
              count: 200,
            },

            removeOnFail: {
              count: 500,
            },
          },
        ),
      ])

    const isPublic =
      !['kyc_document', 'venue_verification']
        .includes(opts.assetType)

    return {

      message:
        'Upload confirmed — processing in background',

      assetId: updatedAsset.id,

      cdnUrl: isPublic
        ? this.storage.cdnUrl(
          this.cdnBase,
          updatedAsset.file_key,
        )
        : undefined,

      webpKey: null,
      thumbKey: null,
      status: 'processing',
    }
  }

  /* ───────────────── Step 3 — Status Polling ───────────────── */

  async getUploadStatus(
    assetId: string,
    ownerId: string,
  ): Promise<UploadStatusResult> {

    const cacheKey =
      `media:status:${assetId}`

    const cached =
      await this.redis.get<UploadStatusResult>(
        cacheKey,
      )

    if (cached) return cached

    const asset =
      await this.prisma.media_assets.findFirst({
        where: {
          id: assetId,
          uploader_id: ownerId,
        },

        select: {
          status: true,
          webp_key: true,
          thumb_key: true,
        },
      })

    if (!asset)
      throw new NotFoundException(
        'Asset not found',
      )

    const result: UploadStatusResult = {

      status: asset.status as any,

      progress:
        asset.status === 'completed' ? 100 : asset.status === 'processing' ? 50 : 0,

      webpKey:
        asset.webp_key,

      thumbKey:
        asset.thumb_key,

      thumbUrl:
        asset.thumb_key
          ? this.storage.cdnUrl(
            this.cdnBase,
            asset.thumb_key,
          )
          : undefined,
    }

    if (
      asset.status === 'processing' ||
      asset.status === 'pending'
    ) {

      await this.redis.set(
        cacheKey,
        result,
        STATUS_CACHE_TTL,
      )
    }

    return result
  }

  /* ───────────────── Gallery ───────────────── */

  async getGallery(
    venueId: string,
  ): Promise<GalleryItem[]> {

    const cacheKey =
      `media:gallery:${venueId}`

    const cached =
      await this.redis.get<GalleryItem[]>(
        cacheKey,
      )

    if (cached) return cached

    const assets =
      await this.prisma.media_assets.findMany({
        where: {
          asset_type: 'VENUE_GALLERY',
          status: 'completed',
        },

        select: {
          id: true,
          file_key: true,
          webp_key: true,
          thumb_key: true,
          created_at: true,
          status: true,
        },

        orderBy: {
          created_at: 'desc',
        },

        take: 50,
      })

    const items: GalleryItem[] =
      assets.map(
        (a: any) => ({

          assetId: a.id,

          key: a.file_key,

          cdnUrl:
            this.storage.cdnUrl(
              this.cdnBase,
              a.file_key,
            ),

          webpUrl:
            a.webp_key
              ? this.storage.cdnUrl(
                this.cdnBase,
                a.webp_key,
              )
              : undefined,

          thumbUrl:
            a.thumb_key
              ? this.storage.cdnUrl(
                this.cdnBase,
                a.thumb_key,
              )
              : undefined,

          uploadedAt:
            a.created_at,

          status:
            a.status as any,
        }),
      )

    await this.redis.set(
      cacheKey,
      items,
      GALLERY_CACHE_TTL,
    )

    return items
  }
  /* ───────────────── Signed URLs (Admin Workflow) ───────────────── */

  async getAllKycDocUrls(ownerId: string, expiresIn = 600): Promise<Array<{ docType: string, downloadUrl: string, expiresIn: number, uploadedAt: Date }>> {
    const assets = await this.prisma.media_assets.findMany({
      where: {
        uploader_id: ownerId,
        asset_type: { in: ['OWNER_CITIZENSHIP', 'OWNER_BUSINESS_REGISTRATION', 'OWNER_PAN'] },
      },
      orderBy: { created_at: 'desc' },
      select: { file_key: true, created_at: true },
    })

    const items = await Promise.all(
      assets.map(async (asset: { file_key: string; created_at: Date }) => {
        const match = asset.file_key.match(/\/kyc\/([^/.]+)\.[a-z0-9]+$/i)
        const docType = match ? match[1] : 'document'
        const downloadUrl = await this.storage.presignGet(asset.file_key, expiresIn)

        return {
          docType,
          downloadUrl,
          expiresIn,
          uploadedAt: asset.created_at,
        }
      })
    )

    const uniqueItems: Array<{ docType: string, downloadUrl: string, expiresIn: number, uploadedAt: Date }> = []
    const seen = new Set<string>()

    for (const item of items) {
      if (!seen.has(item.docType)) {
        seen.add(item.docType)
        uniqueItems.push(item)
      }
    }

    return uniqueItems
  }

  async getKycDocUrl(ownerId: string, docType?: string, expiresIn = 600): Promise<{ downloadUrl: string; expiresIn: number }> {
    const asset = await this.prisma.media_assets.findFirst({
      where: {
        uploader_id: ownerId,
        asset_type: { in: ['OWNER_CITIZENSHIP', 'OWNER_BUSINESS_REGISTRATION', 'OWNER_PAN'] },
        ...(docType ? { file_key: { contains: `/kyc/${docType}.` } } : {}),
      },
      orderBy: { created_at: 'desc' },
      select: { file_key: true },
    })

    if (!asset) {
      throw new NotFoundException('KYC document not found')
    }

    const downloadUrl = await this.storage.presignGet(asset.file_key, expiresIn)
    return { downloadUrl, expiresIn }
  }

  async getVerificationDocUrl(venueId: string, key: string, expiresIn = 600): Promise<{ downloadUrl: string; expiresIn: number }> {
    const asset = await this.prisma.media_assets.findFirst({
      where: {
        asset_type: 'SYSTEM',
        file_key: key,
      },
      select: { file_key: true },
    })

    if (!asset) {
      throw new NotFoundException('Verification document not found')
    }

    const downloadUrl = await this.storage.presignGet(asset.file_key, expiresIn)
    return { downloadUrl, expiresIn }
  }

  async getImageUrl(key: string, expiresIn = 300): Promise<string> {
    return this.storage.presignGet(key, expiresIn)
  }
  /* ───────────────── Delete ───────────────── */

  async deleteAsset(
    assetId: string,
    ownerId: string,
  ): Promise<{ message: string }> {

    const asset =
      await this.prisma.media_assets.findFirst({
        where: {
          id: assetId,
          uploader_id: ownerId,
        },

        select: {
          id: true,
          file_key: true,
          webp_key: true,
          thumb_key: true,
        },
      })

    if (!asset)
      throw new NotFoundException(
        'Asset not found',
      )

    const keysToDelete = [

      asset.file_key,

      asset.webp_key,

      asset.thumb_key,

    ].filter(Boolean) as string[]

    await Promise.allSettled(
      keysToDelete.map(k =>
        this.storage.delete(k),
      ),
    )

    await this.prisma.media_assets.delete({
      where: { id: assetId },
    })

    const venueId =
      asset.file_key.split('/')[1]

    if (venueId) {

      void this.redis.del(
        `media:gallery:${venueId}`,
      )
    }

    return { message: 'Asset deleted' }
  }

  /* ───────────────── Ownership ───────────────── */

  private async validateOwnership(
    opts: RequestUploadUrlOptions,
  ): Promise<void> {

    // 1. Enforce uploader referential integrity (Service-Layer FK check)
    const uploaderType = opts.assetType === 'player_profile' ? 'USER' : 'OWNER'

    if (uploaderType === 'USER') {
      const user = await this.prisma.users.findUnique({
        where: { id: opts.ownerId },
        select: { id: true },
      })
      if (!user) throw new ForbiddenException('Uploader user not found')
    } else if (uploaderType === 'OWNER') {
      const owner = await this.prisma.owners.findUnique({
        where: { id: opts.ownerId },
        select: { id: true },
      })
      if (!owner) throw new ForbiddenException('Uploader owner not found')
    }

    // 2. Enforce domain entity ownership
    switch (opts.assetType) {

      case 'player_profile':
      case 'owner_profile':
      case 'kyc_document':

        if (
          opts.entityId !==
          opts.ownerId
        ) {

          throw new ForbiddenException(
            'You can only upload to your own media folder',
          )
        }

        return

      case 'venue_cover':
      case 'venue_gallery':
      case 'venue_verification': {

        const venue =
          await this.prisma.venues.findFirst({
            where: {
              id: opts.entityId,
              owner_id: opts.ownerId,
            },

            select: { id: true },
          })

        if (!venue) {

          throw new ForbiddenException(
            'Venue not found or access denied',
          )
        }

        return
      }

      default:
        throw new BadRequestException(
          `Unknown assetType: ${opts.assetType}`,
        )
    }
  }
}
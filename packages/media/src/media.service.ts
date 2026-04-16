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

    const [uploadUrl, assetRow] =
      await Promise.all([

        this.storage.presignUpload({
          key,
          contentType,
          cacheControl:
            getCacheControl(opts.assetType),
          expiresIn: 600,
        }),

        this.prisma.media_assets.create({
          data: {
            key,
            assetType: opts.assetType,
            status: 'pending',
            uploaderId: opts.ownerId,
            entityId: opts.entityId,
            progress: 0,
          },

          select: { id: true },
        }),
      ])

    const result: UploadUrlResult = {
      assetId: assetRow.id,
      uploadUrl,
      key,
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
          uploaderId: opts.ownerId,
        },

        select: {
          id: true,
          status: true,
          key: true,
        },
      })

    if (!asset)
      throw new NotFoundException(
        'Asset not found',
      )

    if (asset.key !== opts.key) {
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
            asset.key,
          ),

        webpKey:
          predictWebpKey(asset.key),

        thumbKey:
          predictThumbKey(asset.key),

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
            progress: 0,
            updatedAt: new Date(),
          },

          select: {
            id: true,
            key: true,
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
            updatedAsset.key,
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
          uploaderId: ownerId,
        },

        select: {
          status: true,
          progress: true,
          webpKey: true,
          thumbKey: true,
        },
      })

    if (!asset)
      throw new NotFoundException(
        'Asset not found',
      )

    const result: UploadStatusResult = {

      status: asset.status as any,

      progress:
        asset.progress ?? 0,

      webpKey:
        asset.webpKey,

      thumbKey:
        asset.thumbKey,

      thumbUrl:
        asset.thumbKey
          ? this.storage.cdnUrl(
              this.cdnBase,
              asset.thumbKey,
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
          entityId: venueId,
          assetType: 'venue_gallery',
          status: 'ready',
        },

        select: {
          id: true,
          key: true,
          webpKey: true,
          thumbKey: true,
          createdAt: true,
          status: true,
        },

        orderBy: {
          createdAt: 'desc',
        },

        take: 50,
      })

    const items: GalleryItem[] =
      assets.map(
        (a: GalleryAsset) => ({

          assetId: a.id,

          key: a.key,

          cdnUrl:
            this.storage.cdnUrl(
              this.cdnBase,
              a.key,
            ),

          webpUrl:
            a.webpKey
              ? this.storage.cdnUrl(
                  this.cdnBase,
                  a.webpKey,
                )
              : undefined,

          thumbUrl:
            a.thumbKey
              ? this.storage.cdnUrl(
                  this.cdnBase,
                  a.thumbKey,
                )
              : undefined,

          uploadedAt:
            a.createdAt,

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
        entityId: ownerId,
        assetType: 'kyc_document',
      },
      orderBy: { createdAt: 'desc' },
      select: { key: true, createdAt: true },
    })

    const items = await Promise.all(
      assets.map(async (asset: { key: string; createdAt: Date }) => {
        const match = asset.key.match(/\/kyc\/([^/.]+)\.[a-z0-9]+$/i)
        const docType = match ? match[1] : 'document'
        const downloadUrl = await this.storage.presignGet(asset.key, expiresIn)

        return {
          docType,
          downloadUrl,
          expiresIn,
          uploadedAt: asset.createdAt,
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
        entityId: ownerId,
        assetType: 'kyc_document',
        ...(docType ? { key: { contains: `/kyc/${docType}.` } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: { key: true },
    })

    if (!asset) {
      throw new NotFoundException('KYC document not found')
    }

    const downloadUrl = await this.storage.presignGet(asset.key, expiresIn)
    return { downloadUrl, expiresIn }
  }

  async getVerificationDocUrl(venueId: string, key: string, expiresIn = 600): Promise<{ downloadUrl: string; expiresIn: number }> {
    const asset = await this.prisma.media_assets.findFirst({
      where: {
        entityId: venueId,
        assetType: 'venue_verification',
        key,
      },
      select: { key: true },
    })

    if (!asset) {
      throw new NotFoundException('Verification document not found')
    }

    const downloadUrl = await this.storage.presignGet(asset.key, expiresIn)
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
          uploaderId: ownerId,
        },

        select: {
          id: true,
          key: true,
          webpKey: true,
          thumbKey: true,
        },
      })

    if (!asset)
      throw new NotFoundException(
        'Asset not found',
      )

    const keysToDelete = [

      asset.key,

      asset.webpKey,

      asset.thumbKey,

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
      asset.key.split('/')[1]

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
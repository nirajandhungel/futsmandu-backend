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
import type { Prisma } from '@futsmandu/database'
// ── Import generated Prisma enums so queries are fully typed ──────────────────
// Adjust this path to match wherever your generated client is re-exported from.
import {
  media_asset_type,
  media_status,
  actor_type,
  owner_kyc_type,
  kyc_status,
  venue_media_type,
} from '@futsmandu/database'
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
  AssetStatus,
} from '@futsmandu/media-core'

import { QUEUE_IMAGE_PROCESSING } from '@futsmandu/queues'
import { ENV } from '@futsmandu/utils'

/* ───────────────── Constants ───────────────── */

const MAGIC_BYTES: Record<string, string> = {
  ffd8ff:     'image/jpeg',
  '89504e47': 'image/png',
  '52494646': 'image/webp',
  '25504446': 'application/pdf',
}

const STATUS_CACHE_TTL_TRANSIENT = 5    // seconds — pending / processing (poll frequently)
const STATUS_CACHE_TTL_TERMINAL  = 300  // seconds — completed / failed (immutable, cache longer)
const GALLERY_CACHE_TTL          = 120  // seconds

// Maps our AssetType to the Prisma-generated media_asset_type enum member.
// Centralised here so it's maintained in one place.
const DB_ASSET_TYPE_MAP = {
  player_profile:     media_asset_type.USER_AVATAR,
  owner_profile:      media_asset_type.OWNER_AVATAR,
  venue_cover:        media_asset_type.VENUE_COVER,
  venue_gallery:      media_asset_type.VENUE_GALLERY,
  venue_verification: media_asset_type.SYSTEM,
  // kyc_document is resolved dynamically below (depends on docType)
} as const satisfies Partial<Record<AssetType, media_asset_type>>

/* ───────────────── Service ───────────────── */

@Injectable()
export class MediaService {

  private readonly logger  = new Logger(MediaService.name)
  private readonly cdnBase: string

  constructor(
    private readonly prisma:    PrismaService,
    private readonly storage:   StorageService,
    private readonly redis:     RedisService,

    @InjectQueue(QUEUE_IMAGE_PROCESSING)
    private readonly imgQueue: Queue,
  ) {
    this.cdnBase = (
      ENV['S3_CDN_BASE_URL'] || ENV['S3_ENDPOINT'] || ''
    ).replace(/\/+$/, '')
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * PRIVATE HELPERS
   * ─────────────────────────────────────────────────────────────────────── */

  /** Resolves the correct Prisma enum value for a KYC docType. */
  private kycDbAssetType(docType?: string): media_asset_type {
    if (docType === 'business_registration') return media_asset_type.OWNER_BUSINESS_REGISTRATION
    if (docType === 'business_pan')          return media_asset_type.OWNER_PAN
    return media_asset_type.OWNER_CITIZENSHIP
  }

  /** True for asset types whose keys should be served via public CDN. */
  private isPublicAsset(assetType: AssetType): boolean {
    return assetType !== 'kyc_document' && assetType !== 'venue_verification'
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * STEP 1 — REQUEST UPLOAD URL
   * ─────────────────────────────────────────────────────────────────────── */

  async requestUploadUrl(opts: RequestUploadUrlOptions): Promise<UploadUrlResult> {
    // Ownership validation — single DB query for venue types (see validateOwnership)
    await this.validateOwnership(opts)

    const allowedMimes   = getAllowedMimeTypesForAssetType(opts.assetType)
    const contentType    = opts.contentType && (allowedMimes as readonly string[]).includes(opts.contentType)
      ? opts.contentType
      : allowedMimes[0]

    const ext            = getPreferredExtensionForMimeType(
      contentType as Parameters<typeof getPreferredExtensionForMimeType>[0],
    )
    const key            = generateMediaKey({ assetType: opts.assetType, entityId: opts.entityId, docType: opts.docType, extension: ext })
    const cacheControlStr = getCacheControl(opts.assetType)

    const dbAssetType: media_asset_type = opts.assetType === 'kyc_document'
      ? this.kycDbAssetType(opts.docType)
      : DB_ASSET_TYPE_MAP[opts.assetType as keyof typeof DB_ASSET_TYPE_MAP]

    // Presign upload + upsert asset row — in parallel
    const [uploadUrl, assetRow] = await Promise.all([
      this.storage.presignUpload({ key, contentType, cacheControl: cacheControlStr, expiresIn: 600 }),

      this.prisma.media_assets.upsert({
        where:  { file_key: key },
        create: {
          file_key:      key,
          asset_type:    dbAssetType,
          status:        media_status.pending,
          uploader_id:   opts.ownerId,
          uploader_type: opts.assetType === 'player_profile' ? actor_type.USER : actor_type.OWNER,
          metadata:      { entityId: opts.entityId, originalAssetType: opts.assetType },
        },
        update: {
          status:        media_status.pending,
          uploader_id:   opts.ownerId,
          uploader_type: opts.assetType === 'player_profile' ? actor_type.USER : actor_type.OWNER,
          metadata:      { entityId: opts.entityId, originalAssetType: opts.assetType },
          updated_at:    new Date(),
        },
        select: { id: true },
      }),
    ])

    return {
      assetId:  assetRow.id,
      uploadUrl,
      key,
      requiredHeaders: {
        'Content-Type':  contentType,
        'Cache-Control': cacheControlStr,
      },
      expiresIn: 600,
      ...(this.isPublicAsset(opts.assetType) && {
        cdnUrl:  this.storage.cdnUrl(this.cdnBase, key),
        webpKey: predictWebpKey(key),
      }),
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * STEP 2 — CONFIRM UPLOAD
   * ─────────────────────────────────────────────────────────────────────── */

  async confirmUpload(opts: ConfirmUploadOptions): Promise<ConfirmUploadResult> {
    const asset = await this.prisma.media_assets.findFirst({
      where:  { id: opts.assetId, uploader_id: opts.ownerId },
      select: { id: true, status: true, file_key: true, asset_type: true, metadata: true },
    })

    if (!asset) throw new NotFoundException('Asset not found')

    if (asset.file_key !== opts.key) throw new BadRequestException('Key mismatch')

    // Idempotent — already confirmed, return current real DB status
    if (asset.status !== media_status.pending) {
      return {
        message:  'Already confirmed',
        assetId:  asset.id,
        cdnUrl:   this.isPublicAsset(opts.assetType)
          ? this.storage.cdnUrl(this.cdnBase, asset.file_key)
          : undefined,
        webpKey:  predictWebpKey(asset.file_key),
        thumbKey: predictThumbKey(asset.file_key),
        status:   asset.status as AssetStatus,
      }
    }

    // ── Magic-byte validation (fail fast on unsupported file types) ──────────
    try {
      const header = await this.storage.downloadRange(opts.key, 0, 7)
      const hex    = header.toString('hex')
      const ok     = Object.keys(MAGIC_BYTES).some(magic => hex.startsWith(magic))

      if (!ok) {
        await this.prisma.media_assets.update({
          where: { id: opts.assetId },
          data:  { status: media_status.failed },
        })
        throw new BadRequestException('Unsupported file type')
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err
      // R2 range-request failure is non-fatal — let the processor handle it
      this.logger.warn(`[${opts.assetId}] Magic check failed — continuing`)
    }

    const meta     = (asset.metadata ?? {}) as Record<string, string>
    const entityId = meta['entityId'] ?? opts.ownerId

    /* ── KYC / verification docs ─────────────────────────────────────────────
     * These asset types need ZERO image processing — the raw file is used as-is.
     * Skip BullMQ entirely: mark completed inline so the client sees status=completed
     * on the very NEXT poll (< 100 ms) instead of waiting 1-2 min for a worker.
     * ─────────────────────────────────────────────────────────────────────── */
    if (opts.assetType === 'kyc_document' || opts.assetType === 'venue_verification') {
      const [updatedAsset] = await Promise.all([
        this.prisma.media_assets.update({
          where:  { id: opts.assetId },
          data:   { status: media_status.completed, updated_at: new Date() },
          select: { id: true, file_key: true },
        }),

        // Domain link (owner_kyc_documents row) — fire-and-forget, microseconds
        this.writeDomainLink(
          opts.assetType,
          opts.assetId,
          asset.asset_type,
          opts.ownerId,
          entityId,
          asset.file_key,
        ).catch(e => this.logger.error(`[${opts.assetId}] Domain link write failed: ${e?.message}`)),

        // Bust status cache so next poll immediately sees 'completed'
        // void = true fire-and-forget (no hidden .catch micro-task overhead)
        void this.redis.del(`media:status:${opts.assetId}`),
      ])

      this.logger.log(`[${opts.assetId}] ${opts.assetType} confirmed inline (no processing needed)`)

      return {
        message:  'Upload confirmed — ready',
        assetId:  updatedAsset.id,
        cdnUrl:   undefined, // private asset — use presigned URL via getUploadStatus
        webpKey:  null,
        thumbKey: null,
        status:   'completed',
      }
    }

    /* ── Image assets — queue for sharp processing ────────────────────────── */
    const { width, height } = getResizeDimensions(opts.assetType)

    // DB update + queue add + domain link write — all in parallel
    const [updatedAsset] = await Promise.all([
      this.prisma.media_assets.update({
        where:  { id: opts.assetId },
        data:   { status: media_status.processing, updated_at: new Date() },
        select: { id: true, file_key: true },
      }),

      this.imgQueue.add(
        'process-media',
        {
          assetId:      opts.assetId,
          key:          opts.key,
          bucket:       ENV['S3_BUCKET'],
          assetType:    opts.assetType,
          targetWidth:  width,
          targetHeight: height,
        },
        {
          // Venue uploads are slightly lower priority than avatar uploads
          priority:         opts.assetType.startsWith('venue') ? 2 : 1,
          attempts:         3,
          // backoff only applies to RETRIES — first attempt starts immediately
          backoff:          { type: 'exponential', delay: 5_000 },
          removeOnComplete: { count: 200 },
          removeOnFail:     { count: 500 },
        },
      ),

      // Write domain link row — index-driven, microseconds
      this.writeDomainLink(
        opts.assetType,
        opts.assetId,
        asset.asset_type,
        opts.ownerId,
        entityId,
        asset.file_key,
      ).catch(e => this.logger.error(`[${opts.assetId}] Domain link write failed: ${e?.message}`)),
    ])

    return {
      message:  'Upload confirmed — processing in background',
      assetId:  updatedAsset.id,
      cdnUrl:   this.isPublicAsset(opts.assetType)
        ? this.storage.cdnUrl(this.cdnBase, updatedAsset.file_key)
        : undefined,
      webpKey:  null,
      thumbKey: null,
      status:   'processing',
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * DOMAIN LINK WRITER
   * Writes/updates the correct link table row each time an upload is confirmed.
   * Runs in parallel with the BullMQ queue add — zero extra latency on reads.
   * ─────────────────────────────────────────────────────────────────────── */

  // Maps media_asset_type → owner_kyc_type (only KYC asset types are present)
  private static readonly KYC_TYPE_MAP: Partial<Record<media_asset_type, owner_kyc_type>> = {
    [media_asset_type.OWNER_CITIZENSHIP]:           owner_kyc_type.CITIZENSHIP,
    [media_asset_type.OWNER_BUSINESS_REGISTRATION]: owner_kyc_type.BUSINESS_REGISTRATION,
    [media_asset_type.OWNER_PAN]:                   owner_kyc_type.PAN,
  }

  private async writeDomainLink(
    assetType:   string,
    mediaId:     string,
    dbAssetType: media_asset_type,
    ownerId:     string,
    entityId:    string,
    fileKey:     string,
  ): Promise<void> {
    switch (assetType) {

      // ── KYC document → owner_kyc_documents ──────────────────────────────
      case 'kyc_document': {
        const kycType = MediaService.KYC_TYPE_MAP[dbAssetType]
        if (!kycType) return

        // Single upsert on @@unique([owner_id, type]) — 1 DB round-trip instead of 2
        // Re-upload path: swaps media and resets status → PENDING so admin re-reviews
        await this.prisma.owner_kyc_documents.upsert({
          where:  { owner_id_type: { owner_id: ownerId, type: kycType } },
          create: { owner_id: ownerId, type: kycType, media_id: mediaId },
          update: {
            media_id:         mediaId,
            status:           kyc_status.PENDING,
            verified_by:      null,
            verified_at:      null,
            rejection_reason: null,
          },
        })
        return
      }

      // ── Venue cover → venue_media (COVER) + venues cache ────────────────
      case 'venue_cover': {
        const cdnUrl = this.storage.cdnUrl(this.cdnBase, fileKey)
        // Single upsert on @@unique([venue_id, type]) — 1 DB round-trip instead of 2
        await Promise.all([
          this.prisma.venue_media.upsert({
            where:  { venue_media_venue_id_type_key: { venue_id: entityId, type: venue_media_type.COVER } },
            create: { venue_id: entityId, media_id: mediaId, type: venue_media_type.COVER },
            update: { media_id: mediaId },
          }),
          // Keep denormalized cover_image_url in sync — fast reads on discovery/listing
          this.prisma.venues.update({
            where: { id: entityId },
            data:  { cover_image_url: cdnUrl, updated_at: new Date() },
          }),
        ])
        return
      }

      // ── Venue gallery → venue_media (GALLERY) ───────────────────────────
      case 'venue_gallery': {
        await this.prisma.venue_media.create({
          data: { venue_id: entityId, media_id: mediaId, type: venue_media_type.GALLERY },
        })
        // Bust gallery Redis cache so next read is fresh
        void this.redis.del(`media:gallery:${entityId}`)
        return
      }

      // ── Player avatar → user_avatars ────────────────────────────────────
      case 'player_profile': {
        // Deactivate previous avatar, create new active one — two indexed writes
        await this.prisma.$transaction([
          this.prisma.user_avatars.updateMany({
            where: { user_id: entityId, is_active: true },
            data:  { is_active: false },
          }),
          this.prisma.user_avatars.create({
            data: { user_id: entityId, media_id: mediaId, is_active: true },
          }),
        ])
        return
      }

      // ── owner_profile / venue_verification → no separate link table ──────
      default:
        return
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * STEP 3 — STATUS POLLING
   * ─────────────────────────────────────────────────────────────────────── */

  async getUploadStatus(assetId: string, ownerId: string): Promise<UploadStatusResult> {
    const cacheKey = `media:status:${assetId}`
    const cached   = await this.redis.get<UploadStatusResult>(cacheKey)

    // Return cached value ONLY for non-terminal states.
    // Terminal (completed/failed) states skip cache so we always serve fresh signedUrls.
    if (cached && cached.status !== 'completed' && cached.status !== 'failed') return cached

    // Fetch status + all variant keys
    const asset = await this.prisma.media_assets.findFirst({
      where:  { id: assetId, uploader_id: ownerId },
      select: { status: true, webp_key: true, thumb_key: true, file_key: true, asset_type: true },
    })

    if (!asset) throw new NotFoundException('Asset not found')

    // Private assets (KYC, verification docs) — no CDN URLs; use presigned download instead
    const isPublic =
      asset.asset_type !== media_asset_type.OWNER_CITIZENSHIP &&
      asset.asset_type !== media_asset_type.OWNER_BUSINESS_REGISTRATION &&
      asset.asset_type !== media_asset_type.OWNER_PAN &&
      asset.asset_type !== media_asset_type.SYSTEM

    // For completed private assets, generate a presigned URL so Flutter can display the image.
    // Prefer webp_key variant (processed) over raw key — smaller and faster to render.
    // signedUrl is generated fresh per call and NOT stored in Redis to prevent serving expired URLs.
    let signedUrl: string | null = null
    if (!isPublic && asset.status === media_status.completed) {
      const keyToSign = asset.webp_key ?? asset.file_key
      signedUrl = await this.storage.presignGet(keyToSign, 600).catch(() => null)
    }

    const result: UploadStatusResult = {
      status:   asset.status as AssetStatus,
      progress: asset.status === media_status.completed ? 100
              : asset.status === media_status.processing ? 50
              : 0,
      webpKey:    asset.webp_key  ?? null,
      thumbKey:   asset.thumb_key ?? null,
      cdnUrl:     isPublic ? this.storage.cdnUrl(this.cdnBase, asset.file_key) : undefined,
      webpUrl:    isPublic && asset.webp_key
        ? this.storage.cdnUrl(this.cdnBase, asset.webp_key)
        : null,
      thumbUrl:   asset.thumb_key
        ? this.storage.cdnUrl(this.cdnBase, asset.thumb_key)
        : null,
      signedUrl, // null for public assets or non-completed private assets
    }

    // Only cache transient states — terminal results are cheap to re-fetch and must always
    // be served fresh (signedUrls must not come from a stale cache entry).
    if (asset.status === media_status.pending || asset.status === media_status.processing) {
      await this.redis.set(cacheKey, result, STATUS_CACHE_TTL_TRANSIENT)
    }

    return result
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * GALLERY
   * ─────────────────────────────────────────────────────────────────────── */

  async getGallery(venueId: string): Promise<GalleryItem[]> {
    const cacheKey = `media:gallery:${venueId}`
    const cached   = await this.redis.get<GalleryItem[]>(cacheKey)
    if (cached) return cached

    type Row = Prisma.media_assetsGetPayload<{
      select: { id: true; file_key: true; webp_key: true; thumb_key: true; created_at: true; status: true }
    }>

    const assets: Row[] = await this.prisma.media_assets.findMany({
      where: {
        asset_type: media_asset_type.VENUE_GALLERY,
        status:     media_status.completed,
        file_key:   { startsWith: `venues/${venueId}/gallery/` },
        deleted_at: null,
      },
      select:  { id: true, file_key: true, webp_key: true, thumb_key: true, created_at: true, status: true },
      orderBy: { created_at: 'desc' },
      take:    50,
    })

    const items: GalleryItem[] = assets.map(a => ({
      assetId:    a.id,
      key:        a.file_key,
      cdnUrl:     this.storage.cdnUrl(this.cdnBase, a.file_key),
      webpUrl:    a.webp_key  ? this.storage.cdnUrl(this.cdnBase, a.webp_key)  : undefined,
      thumbUrl:   a.thumb_key ? this.storage.cdnUrl(this.cdnBase, a.thumb_key) : undefined,
      uploadedAt: a.created_at,
      status:     a.status as AssetStatus,
    }))

    await this.redis.set(cacheKey, items, GALLERY_CACHE_TTL)
    return items
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * KYC SIGNED URLS
   * ─────────────────────────────────────────────────────────────────────── */

  async getAllKycDocUrls(
    ownerId:   string,
    expiresIn = 600,
  ): Promise<Array<{
    assetId:         string
    docType:         string
    downloadUrl:     string
    expiresIn:       number
    uploadedAt:      Date
    /** KYC verification status: PENDING | VERIFIED | REJECTED */
    kycStatus:       string
    rejectionReason: string | null
  }>> {

    // Single query — join media_assets → owner_kyc_documents in one round-trip
    type KycRow = Prisma.media_assetsGetPayload<{
      select: {
        id: true
        file_key: true
        webp_key: true
        status: true
        created_at: true
        owner_kyc_documents: {
          select: { status: true; rejection_reason: true }
          take: 1
          orderBy: { created_at: 'desc' }
        }
      }
    }>

    const assets: KycRow[] = await this.prisma.media_assets.findMany({
      where: {
        uploader_id: ownerId,
        asset_type: { in: [
          media_asset_type.OWNER_CITIZENSHIP,
          media_asset_type.OWNER_BUSINESS_REGISTRATION,
          media_asset_type.OWNER_PAN,
        ]},
        deleted_at: null,
      },
      orderBy: { created_at: 'desc' },
      select: {
        id:          true,
        file_key:    true,
        webp_key:    true,
        status:      true,
        created_at:  true,
        owner_kyc_documents: {
          select:  { status: true, rejection_reason: true },
          take:    1,
          orderBy: { created_at: 'desc' },
        },
      },
    })

    // De-duplicate: keep the latest asset per docType slug
    const seenTypes  = new Set<string>()
    const unique = assets.filter((a: KycRow) => {
      const match   = a.file_key.match(/\/kyc\/([^/.]+)\.[a-z0-9]+$/i)
      const docType = match ? match[1] : 'document'
      if (seenTypes.has(docType)) return false
      seenTypes.add(docType)
      return true
    })

    // Prefer the processed webp variant for display (smaller, faster) — fall back to original
    const keysToSign = unique.map((a: KycRow) => a.webp_key ?? a.file_key)
    const signedUrls = await this.storage.presignGetBatch(keysToSign, expiresIn)

    return unique.map((a: KycRow, i: number) => {
      const match   = a.file_key.match(/\/kyc\/([^/.]+)\.[a-z0-9]+$/i)
      const kycDoc  = (a.owner_kyc_documents as Array<{ status: string; rejection_reason: string | null }>)[0]
      return {
        assetId:         a.id,
        docType:         match ? match[1] : 'document',
        downloadUrl:     signedUrls[i] ?? '',
        expiresIn,
        uploadedAt:      a.created_at,
        kycStatus:       kycDoc?.status       ?? 'PENDING',
        rejectionReason: kycDoc?.rejection_reason ?? null,
      }
    })
  }

  async getKycDocUrl(
    ownerId:   string,
    docType?:  string,
    expiresIn = 600,
  ): Promise<{ downloadUrl: string; expiresIn: number }> {
    const asset = await this.prisma.media_assets.findFirst({
      where: {
        uploader_id: ownerId,
        asset_type: { in: [
          media_asset_type.OWNER_CITIZENSHIP,
          media_asset_type.OWNER_BUSINESS_REGISTRATION,
          media_asset_type.OWNER_PAN,
        ]},
        ...(docType ? { file_key: { contains: `/${docType}.` } } : {}),
        deleted_at: null,
      },
      orderBy: { created_at: 'desc' },
      select:  { file_key: true },
    })

    if (!asset) throw new NotFoundException('KYC document not found')

    return { downloadUrl: await this.storage.presignGet(asset.file_key, expiresIn), expiresIn }
  }

  async getVerificationDocUrl(
    venueId:   string,
    key:       string,
    expiresIn = 600,
  ): Promise<{ downloadUrl: string; expiresIn: number }> {
    const expectedPrefix = `venues/${venueId}/verification/`
    if (!key.startsWith(expectedPrefix)) {
      throw new ForbiddenException('Key does not belong to this venue')
    }

    const asset = await this.prisma.media_assets.findFirst({
      where:  { file_key: key, asset_type: media_asset_type.SYSTEM, deleted_at: null },
      select: { file_key: true },
    })

    if (!asset) throw new NotFoundException('Verification document not found')

    return { downloadUrl: await this.storage.presignGet(asset.file_key, expiresIn), expiresIn }
  }

  async getImageUrl(key: string, expiresIn = 300): Promise<string> {
    return this.storage.presignGet(key, expiresIn)
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * DELETE
   * ─────────────────────────────────────────────────────────────────────── */

  async deleteAsset(assetId: string, ownerId: string): Promise<{ message: string }> {
    const asset = await this.prisma.media_assets.findFirst({
      where:  { id: assetId, uploader_id: ownerId },
      select: { id: true, file_key: true, webp_key: true, thumb_key: true },
    })

    if (!asset) throw new NotFoundException('Asset not found')

    // Delete all R2 variants in parallel — allSettled so a missing webp/thumb doesn't abort
    await Promise.allSettled(
      ([asset.file_key, asset.webp_key, asset.thumb_key].filter(Boolean) as string[])
        .map(k => this.storage.delete(k)),
    )

    await this.prisma.media_assets.delete({ where: { id: assetId } })

    // Invalidate gallery cache only if this was a gallery asset
    // (avoids pointless Redis DEL calls for avatar/kyc/cover deletes)
    if (asset.file_key.includes('/gallery/')) {
      const venueId = asset.file_key.split('/')[1]
      if (venueId) void this.redis.del(`media:gallery:${venueId}`)
    }

    // Invalidate status cache
    void this.redis.del(`media:status:${assetId}`)

    return { message: 'Asset deleted' }
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * OWNERSHIP VALIDATION
   * ─────────────────────────────────────────────────────────────────────── */

  private async validateOwnership(opts: RequestUploadUrlOptions): Promise<void> {
    switch (opts.assetType) {

      // ── Personal assets: entityId must match the caller ────────────────────
      case 'player_profile': {
        if (opts.entityId !== opts.ownerId) throw new ForbiddenException('You can only upload to your own media folder')
        const user = await this.prisma.users.findUnique({ where: { id: opts.ownerId }, select: { id: true } })
        if (!user) throw new ForbiddenException('Uploader user not found')
        return
      }

      case 'owner_profile':
      case 'kyc_document': {
        if (opts.entityId !== opts.ownerId) throw new ForbiddenException('You can only upload to your own media folder')
        // Owner existence is implicitly guaranteed by the JWT guard upstream —
        // no extra DB query needed here.
        return
      }

      // ── Venue assets: one query proves both ownership AND venue existence ───
      // PERF FIX: removed the separate owner existence check that ran before this.
      // The venue query WHERE id = entityId AND owner_id = ownerId is sufficient:
      // if it returns a row, the owner exists and owns that venue.
      case 'venue_cover':
      case 'venue_gallery':
      case 'venue_verification': {
        const venue = await this.prisma.venues.findFirst({
          where:  { id: opts.entityId, owner_id: opts.ownerId, deleted_at: null },
          select: { id: true },
        })
        if (!venue) throw new ForbiddenException('Venue not found or access denied')
        return
      }

      default:
        throw new BadRequestException(`Unknown assetType: ${opts.assetType}`)
    }
  }
}
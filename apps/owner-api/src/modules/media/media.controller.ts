// apps/owner-api/src/modules/media/media.controller.ts
// ─── ADDITIVE UPDATE ──────────────────────────────────────────────────────────
// EXISTING endpoints: all unchanged (upload-url, confirm-upload, kyc/*, profile/*,
//   venues/*/cover, venues/*/gallery, venues/*/verification, download-url, status, delete).
//
// NEW endpoints added:
//   GET  /media/_debug/presign-test          ← debug: verify signed URL generation
//   GET  /media/venues/:venueId/gallery      ← gallery with signed URLs
//   POST /media/kyc/view-url                 ← owner self-view KYC doc (signed)
// ─────────────────────────────────────────────────────────────────────────────

import {
  Controller, Post, Delete, Body, Query, UseGuards, Param, ParseUUIDPipe, Get,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import { MediaService } from '@futsmandu/media'
import {
  RequestUploadUrlDto, ConfirmUploadDto, DeleteAssetDto, OwnerKycUploadUrlDto,
} from '../../dto/media.dto.js'
import { OwnerJwtGuard } from '../../common/guards/owner-jwt.guard.js'
import { CurrentOwner } from '../../common/decorators/current-owner.decorator.js'
import { ENV } from '@futsmandu/utils'

@ApiTags('Media')
@ApiBearerAuth('Owner-JWT')
@UseGuards(OwnerJwtGuard)
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  // ── EXISTING: Generic upload-url ────────────────────────────────────────────
  @Post('upload-url')
  @Throttle({ default: { limit: 50, ttl: 60_000 } })
  @ApiOperation({ summary: 'Request presigned R2 upload URL' })
  requestUploadUrl(
    @CurrentOwner() owner: { id: string },
    @Body() dto: RequestUploadUrlDto,
  ) {
    return this.media.requestUploadUrl({
      assetType:   dto.assetType,
      ownerId:     owner.id,
      entityId:    dto.entityId,
      docType:     dto.docType,
      contentType: dto.contentType,
    })
  }

  // ── EXISTING: Confirm upload ────────────────────────────────────────────────
  @Post('confirm-upload')
  @ApiOperation({ summary: 'Step 3 — Confirm upload complete' })
  confirmUpload(
    @CurrentOwner() owner: { id: string },
    @Body() dto: ConfirmUploadDto,
  ) {
    return this.media.confirmUpload({
      ownerId:   owner.id,
      assetId:   dto.assetId,
      key:       dto.key,
      assetType: dto.assetType,
    } as any)
  }

  // ── EXISTING: KYC upload-url ────────────────────────────────────────────────
  @Post('kyc/upload-url')
  @ApiOperation({ summary: 'Step 1 — Get presigned URL for KYC document upload' })
  requestKycUploadUrl(
    @CurrentOwner() owner: { id: string },
    @Body() dto: OwnerKycUploadUrlDto,
  ) {
    return this.media.requestUploadUrl({
      assetType:   'kyc_document',
      ownerId:     owner.id,
      entityId:    owner.id,
      docType:     dto.docType,
      contentType: dto.contentType,
    })
  }

  // ── NEW: KYC self-view URL (owner sees their own KYC doc) ──────────────────
  @Post('kyc/view-url')
  @ApiOperation({
    summary: 'Get a signed URL to view your uploaded KYC document',
    description:
      'Returns a time-limited signed GET URL for the specified KYC docType. ' +
      'Works regardless of USE_SIGNED_IMAGE_URLS flag (KYC is always private).',
  })
  getKycViewUrl(
    @CurrentOwner() owner: { id: string },
    @Body('docType') docType: string,
  ) {
    return this.media.getKycDocSignedUrl(owner.id, docType, 600)
  }

  // ── EXISTING: Owner profile avatar ─────────────────────────────────────────
  @Post('profile/avatar/upload-url')
  @ApiOperation({ summary: 'Step 1 — Get presigned URL for owner avatar upload' })
  requestOwnerAvatarUploadUrl(@CurrentOwner() owner: { id: string }) {
    return this.media.requestUploadUrl({
      assetType: 'owner_profile',
      ownerId:   owner.id,
      entityId:  owner.id,
    })
  }

  // ── EXISTING: Venue cover upload ────────────────────────────────────────────
  @Post('venues/:venueId/cover/upload-url')
  @ApiParam({ name: 'venueId', description: 'UUID of the venue' })
  @ApiOperation({ summary: 'Step 1 — Get presigned URL for venue cover image upload' })
  requestVenueCoverUploadUrl(
    @CurrentOwner() owner: { id: string },
    @Param('venueId', ParseUUIDPipe) venueId: string,
  ) {
    return this.media.requestUploadUrl({
      assetType: 'venue_cover',
      ownerId:   owner.id,
      entityId:  venueId,
    })
  }

  // ── EXISTING: Venue gallery upload ─────────────────────────────────────────
  @Post('venues/:venueId/gallery/upload-url')
  @ApiParam({ name: 'venueId', description: 'UUID of the venue' })
  @ApiOperation({ summary: 'Step 1 — Get presigned URL for a venue gallery image upload' })
  requestVenueGalleryUploadUrl(
    @CurrentOwner() owner: { id: string },
    @Param('venueId', ParseUUIDPipe) venueId: string,
  ) {
    return this.media.requestUploadUrl({
      assetType: 'venue_gallery',
      ownerId:   owner.id,
      entityId:  venueId,
    })
  }

  // ── EXISTING: Venue verification upload ────────────────────────────────────
  @Post('venues/:venueId/verification/upload-url')
  @ApiParam({ name: 'venueId', description: 'UUID of the venue' })
  @ApiOperation({ summary: 'Step 1 — Get presigned URL for venue verification document upload' })
  requestVenueVerificationUploadUrl(
    @CurrentOwner() owner: { id: string },
    @Param('venueId', ParseUUIDPipe) venueId: string,
  ) {
    return this.media.requestUploadUrl({
      assetType: 'venue_verification',
      ownerId:   owner.id,
      entityId:  venueId,
    })
  }

  // ── EXISTING: Signed download URL ──────────────────────────────────────────
  @Post('download-url')
  @ApiOperation({ summary: 'Get a signed download URL for a private asset (KYC / venue verification)' })
  getSignedDownloadUrl(@Body('key') key: string) {
    return this.media.getSignedDownloadUrl({ key })
  }

  // ── NEW: Gallery listing with signed URLs ───────────────────────────────────
  @Get('venues/:venueId/gallery')
  @ApiParam({ name: 'venueId', description: 'UUID of the venue' })
  @ApiOperation({
    summary: 'List venue gallery images with signed URLs',
    description:
      'Returns gallery images. When USE_SIGNED_IMAGE_URLS=true, each image ' +
      'includes a signed_url field (valid 1 hour) alongside the legacy cdn_url.',
  })
  async getVenueGallery(
    @CurrentOwner() owner: { id: string },
    @Param('venueId', ParseUUIDPipe) venueId: string,
  ) {
    const images = await this.media.getGallerySignedUrls(venueId)
    // Return both fields for backward compat
    return images.map(img => ({
      asset_id:   img.assetId,
      key:        img.key,
      cdn_url:    img.cdnUrl,            // legacy — always present
      signed_url: img.signedUrl ?? null, // new — present when flag=true
      webp_url:   img.webpUrl ?? null,
      uploaded_at: img.uploadedAt,
    }))
  }

  // ── EXISTING: Status poll ───────────────────────────────────────────────────
  @Get('status/:assetId')
  @ApiOperation({ summary: 'Poll upload/processing status' })
  getUploadStatus(
    @CurrentOwner() owner: { id: string },
    @Param('assetId', ParseUUIDPipe) assetId: string,
  ) {
    return this.media.getUploadStatus(assetId, owner.id)
  }

  // ── EXISTING: Delete asset ──────────────────────────────────────────────────
  @Delete('asset')
  @ApiOperation({ summary: 'Delete an R2 asset you own' })
  deleteAsset(
    @CurrentOwner() owner: { id: string },
    @Query() dto: DeleteAssetDto,
  ) {
    return this.media.deleteAsset(dto.assetId, owner.id)
  }

  // ── NEW: Debug endpoint — verify signed URL generation (non-production safe) ─
  @Get('_debug/presign-test')
  @ApiOperation({
    summary: '[DEBUG] Test presigned URL generation',
    description:
      'Returns a test signed URL, expiry, and config info. ' +
      'Only active when NODE_ENV !== production. ' +
      'Use to verify R2 credentials and signed URL flow before enabling USE_SIGNED_IMAGE_URLS.',
  })
  async debugPresignTest(@Query('key') key: string) {
    if (ENV['NODE_ENV'] === 'production') {
      return { error: 'Debug endpoint disabled in production' }
    }

    const testKey = key || 'venues/test-venue-id/cover/test.jpg'
    const flagEnabled = ENV['USE_SIGNED_IMAGE_URLS'] === 'true'

    try {
      const signedUrl = await this.media.getSignedImageUrl(testKey, 300)
      return {
        ok:            true,
        flag_enabled:  flagEnabled,
        key_tested:    testKey,
        signed_url:    signedUrl,
        expires_in_s:  300,
        expires_at:    new Date(Date.now() + 300_000).toISOString(),
        bucket:        ENV['S3_BUCKET'] || '(not set)',
        endpoint:      ENV['S3_ENDPOINT'] || '(not set)',
        note:          flagEnabled
          ? 'FLAG ON — signed URLs active in all responses'
          : 'FLAG OFF — legacy CDN URLs used in responses (this URL is from test call)',
      }
    } catch (err: unknown) {
      return {
        ok:           false,
        flag_enabled: flagEnabled,
        key_tested:   testKey,
        error:        err instanceof Error ? err.message : String(err),
      }
    }
  }
}

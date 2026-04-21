// apps/api-owner/src/modules/media/media.controller.ts

import {
  Controller, Post, Get, Delete,
  Body, Query, Param, ParseUUIDPipe, UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import { MediaService } from '@futsmandu/media'
import { OwnerJwtGuard } from '../../common/guards/owner-jwt.guard.js'
import { CurrentOwner } from '../../common/decorators/current-owner.decorator.js'
import {
  ConfirmUploadDto,
  OwnerKycUploadUrlDto,
  DeleteAssetDto,
} from '../../dto/media.dto.js'
// RequestUploadUrlDto removed — generic upload-url endpoint removed

@ApiTags('Media')
@ApiBearerAuth('Owner-JWT')
@UseGuards(OwnerJwtGuard)
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  // ── Confirm + Status (shared step 2 & 3 for all asset types) ─────────────

  @Post('confirm-upload')
  @ApiOperation({
    summary: 'Step 2 — Confirm upload complete',
    description:
      'Call after PUT to R2 succeeds. Validates magic bytes, enqueues processing. ' +
      'Poll /media/status/:assetId every 1.5s until status = ready.',
  })
  confirmUpload(
    @CurrentOwner() owner: { id: string },
    @Body() dto: ConfirmUploadDto,
  ) {
    return this.media.confirmUpload({
      ownerId:   owner.id,
      assetId:   dto.assetId,
      key:       dto.key,
      assetType: dto.assetType,
    })
  }

  @Get('status/:assetId')
  @ApiOperation({
    summary: 'Step 3 — Poll processing status',
    description:
      'Returns { status, progress, webpKey, thumbUrl }. ' +
      'status: pending → processing → ready | failed.',
  })
  getUploadStatus(
    @CurrentOwner() owner: { id: string },
    @Param('assetId', ParseUUIDPipe) assetId: string,
  ) {
    return this.media.getUploadStatus(assetId, owner.id)
  }

  // ── KYC ───────────────────────────────────────────────────────────────────

  @Post('kyc/upload-url')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Step 1 — Get presigned URL for KYC document' })
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

  @Get('kyc')
  @ApiOperation({
    summary: 'Get all KYC documents',
    description: 'Returns all uploaded KYC docs with 10-minute signed download URLs.',
  })
  getAllKycDocuments(@CurrentOwner() owner: { id: string }) {
    return this.media.getAllKycDocUrls(owner.id)
  }

  // ── Owner profile ─────────────────────────────────────────────────────────

  @Post('profile/upload-url')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Step 1 — Get presigned URL for owner profile avatar' })
  requestOwnerAvatarUploadUrl(@CurrentOwner() owner: { id: string }) {
    return this.media.requestUploadUrl({
      assetType: 'owner_profile',
      ownerId:   owner.id,
      entityId:  owner.id,
    })
  }

  // ── Venue assets ──────────────────────────────────────────────────────────

  @Post('venues/:venueId/cover/upload-url')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiParam({ name: 'venueId', type: String })
  @ApiOperation({ summary: 'Step 1 — Get presigned URL for venue cover image' })
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

  @Post('venues/:venueId/gallery/upload-url')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiParam({ name: 'venueId', type: String })
  @ApiOperation({ summary: 'Step 1 — Get presigned URL for venue gallery image' })
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

  @Post('venues/:venueId/verification/upload-url')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiParam({ name: 'venueId', type: String })
  @ApiOperation({ summary: 'Step 1 — Get presigned URL for venue verification document' })
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

  @Get('venues/:venueId/gallery')
  @ApiParam({ name: 'venueId', type: String })
  @ApiOperation({
    summary: 'List venue gallery',
    description: 'CDN + thumb URLs per image. Redis-cached for 2 min.',
  })
  async getVenueGallery(
    @Param('venueId', ParseUUIDPipe) venueId: string,
  ) {
    const items = await this.media.getGallery(venueId)
    return items.map(img => ({
      asset_id:    img.assetId,
      key:         img.key,
      cdn_url:     img.cdnUrl,
      thumb_url:   (img as any).thumbUrl ?? null,
      webp_url:    img.webpUrl            ?? null,
      uploaded_at: img.uploadedAt,
    }))
  }

  @Get('venues/:venueId/verification/:key')
  @ApiParam({ name: 'venueId', type: String })
  @ApiParam({ name: 'key', description: 'Full R2 key of the verification doc', type: String })
  @ApiOperation({ summary: 'Get signed URL for a venue verification document' })
  getVenueVerificationUrl(
    @Param('venueId', ParseUUIDPipe) venueId: string,
    @Param('key') key: string,
  ) {
    return this.media.getVerificationDocUrl(venueId, key)
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  @Delete('asset')
  @ApiOperation({ summary: 'Delete an R2 asset you own' })
  deleteAsset(
    @CurrentOwner() owner: { id: string },
    @Query() dto: DeleteAssetDto,
  ) {
    return this.media.deleteAsset(dto.assetId, owner.id)
  }
}
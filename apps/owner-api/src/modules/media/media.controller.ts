// owner-api/src/modules/media/media.controller.ts
// UPDATED: Consolidated ALL upload endpoints here.
// The old venue-management upload routes (POST /venues/:id/images/upload-url
// and POST /venues/:id/images/confirm) are REMOVED from venue-management.controller.ts.
// Use these endpoints instead for ALL media uploads — KYC, profile, and venue images.
//
// Upload flow (same for every asset type):
//   1. POST /media/<specific-endpoint>/upload-url  → get presigned PUT URL + key
//   2. Client PUTs file directly to the presigned URL (no server involved)
//   3. POST /media/confirm-upload { key, assetType } → server validates + enqueues processing
//   4. GET  /media/status/:assetId → poll until status === 'ready'

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

@ApiTags('Media')
@ApiBearerAuth('Owner-JWT')
@UseGuards(OwnerJwtGuard)
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  // ── Generic upload-url (advanced — use specific shortcuts below when possible) ──
  @Post('upload-url')
  @Throttle({ default: { limit: 50, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Request presigned R2 upload URL',
    description: [
      'Generic endpoint. Prefer the specific shortcuts:',
      '  POST /media/kyc/upload-url',
      '  POST /media/profile/avatar/upload-url',
      '  POST /media/venues/:venueId/cover/upload-url',
      '  POST /media/venues/:venueId/gallery/upload-url',
      '  POST /media/venues/:venueId/verification/upload-url',
    ].join('\n'),
  })
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

  // ── Confirm upload (same endpoint for ALL asset types) ─────────────────────
  @Post('confirm-upload')
  @ApiOperation({
    summary: 'Step 3 — Confirm upload complete',
    description:
      'Call after successfully PUTting the file to the presigned URL. ' +
      'Server validates the file, creates/updates the media_assets record, ' +
      'and enqueues an image-processing job (skipped for kyc_document). ' +
      'Returns assetId — use GET /media/status/:assetId to poll processing status.',
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
    } as any)
  }

  // ── KYC documents ─────────────────────────────────────────────────────────
  @Post('kyc/upload-url')
  @ApiOperation({
    summary: 'Step 1 — Get presigned URL for KYC document upload',
    description:
      'docType: citizenship | business_registration | business_pan. ' +
      'Each docType is a deterministic key (overwriting previous upload). ' +
      'Accepted: image/jpeg, image/png, image/webp, application/pdf (max 5 MB).',
  })
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

  // ── Owner profile avatar ───────────────────────────────────────────────────
  @Post('profile/avatar/upload-url')
  @ApiOperation({
    summary: 'Step 1 — Get presigned URL for owner avatar upload',
    description: 'Accepted: image/jpeg, image/png, image/webp (max 5 MB). Resized to 400×400 px.',
  })
  requestOwnerAvatarUploadUrl(@CurrentOwner() owner: { id: string }) {
    return this.media.requestUploadUrl({
      assetType: 'owner_profile',
      ownerId:   owner.id,
      entityId:  owner.id,
    })
  }

  // ── Venue cover image ──────────────────────────────────────────────────────
  @Post('venues/:venueId/cover/upload-url')
  @ApiParam({ name: 'venueId', description: 'UUID of the venue' })
  @ApiOperation({
    summary: 'Step 1 — Get presigned URL for venue cover image upload',
    description:
      'Accepted: image/jpeg, image/png, image/webp (max 5 MB). ' +
      'Resized to 1280×720 px (16:9). Overwrites previous cover on confirm.',
  })
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

  // ── Venue gallery images ───────────────────────────────────────────────────
  @Post('venues/:venueId/gallery/upload-url')
  @ApiParam({ name: 'venueId', description: 'UUID of the venue' })
  @ApiOperation({
    summary: 'Step 1 — Get presigned URL for a venue gallery image upload',
    description:
      'Each call generates a unique key (UUID). ' +
      'Call once per image. Resized to 1024×768 px. ' +
      'Query ready gallery images via GET /venues/:venueId/gallery.',
  })
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

  // ── Venue verification image ───────────────────────────────────────────────
  @Post('venues/:venueId/verification/upload-url')
  @ApiParam({ name: 'venueId', description: 'UUID of the venue' })
  @ApiOperation({
    summary: 'Step 1 — Get presigned URL for venue verification document upload',
    description:
      'Private asset — not served via CDN. Use GET /media/download-url to get a signed download URL for admin review.',
  })
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

  // ── Signed download URL (private assets only) ─────────────────────────────
  @Post('download-url')
  @ApiOperation({
    summary: 'Get a signed download URL for a private asset (KYC / venue verification)',
    description: 'Only works for private keys (owners/*/kyc/* or venues/*/verification/*). Expires in 600 s.',
  })
  getSignedDownloadUrl(
    @Body('key') key: string,
  ) {
    return this.media.getSignedDownloadUrl({ key })
  }

  // ── Status poll ────────────────────────────────────────────────────────────
  @Get('status/:assetId')
  @ApiOperation({
    summary: 'Poll upload/processing status',
    description: 'Returns { status: "processing" | "ready" | "failed", webpKey? }. Poll until ready.',
  })
  getUploadStatus(
    @CurrentOwner() owner: { id: string },
    @Param('assetId', ParseUUIDPipe) assetId: string,
  ) {
    return this.media.getUploadStatus(assetId, owner.id)
  }

  // ── Delete asset ───────────────────────────────────────────────────────────
  @Delete('asset')
  @ApiOperation({ summary: 'Delete an R2 asset you own' })
  deleteAsset(
    @CurrentOwner() owner: { id: string },
    @Query() dto: DeleteAssetDto,
  ) {
    return this.media.deleteAsset(dto.assetId, owner.id)
  }
}

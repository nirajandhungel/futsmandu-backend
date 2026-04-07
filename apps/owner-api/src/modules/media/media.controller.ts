// apps/owner-api/src/modules/media/media.controller.ts
// Thin controller — zero business logic. All logic lives in @futsmandu/media.
// REPLACES the old media.controller.ts that had hardcoded paths.

import { Controller, Post, Delete, Body, Query, UseGuards, Param, ParseUUIDPipe } from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { MediaService } from '@futsmandu/media'
import { RequestUploadUrlDto, ConfirmUploadDto, DeleteAssetDto, OwnerKycUploadUrlDto } from '../../dto/media.dto.js'
import { OwnerJwtGuard } from '../../common/guards/owner-jwt.guard.js'
import { CurrentOwner } from '../../common/decorators/current-owner.decorator.js'

@ApiTags('Media')
@ApiBearerAuth('Owner-JWT')
@UseGuards(OwnerJwtGuard)
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('upload-url')
  @ApiOperation({ summary: 'Request presigned R2 upload URL (venue images, KYC docs, owner profile)' })
  requestUploadUrl(
    @CurrentOwner() owner: { id: string },
    @Body() dto: RequestUploadUrlDto,
  ) {
    return this.media.requestUploadUrl({
      assetType: dto.assetType,
      ownerId:   owner.id,
      entityId:  dto.entityId,
      docType:   dto.docType,
    })
  }

  @Post('confirm-upload')
  @ApiOperation({ summary: 'Confirm R2 upload complete — triggers image processing job' })
  confirmUpload(
    @CurrentOwner() owner: { id: string },
    @Body() dto: ConfirmUploadDto,
  ) {
    return this.media.confirmUpload({
      ownerId:   owner.id,
      key:       dto.key,
      assetType: dto.assetType,
    } as any)
  }

  @Post('kyc/upload-url')
  @ApiOperation({ summary: 'Get presigned URL for owner KYC document upload' })
  requestKycUploadUrl(
    @CurrentOwner() owner: { id: string },
    @Body() dto: OwnerKycUploadUrlDto,
  ) {
    return this.media.requestUploadUrl({
      assetType: 'kyc_document',
      ownerId: owner.id,
      entityId: owner.id,
      docType: dto.docType,
    })
  }

  @Post('venues/:venueId/images/cover/upload-url')
  @ApiOperation({ summary: 'Get presigned URL for venue cover image upload' })
  requestVenueCoverUploadUrl(
    @CurrentOwner() owner: { id: string },
    @Param('venueId', ParseUUIDPipe) venueId: string,
  ) {
    return this.media.requestUploadUrl({
      assetType: 'venue_cover',
      ownerId: owner.id,
      entityId: venueId,
    })
  }

  @Post('venues/:venueId/images/gallery/upload-url')
  @ApiOperation({ summary: 'Get presigned URL for venue gallery image upload' })
  requestVenueGalleryUploadUrl(
    @CurrentOwner() owner: { id: string },
    @Param('venueId', ParseUUIDPipe) venueId: string,
  ) {
    return this.media.requestUploadUrl({
      assetType: 'venue_gallery',
      ownerId: owner.id,
      entityId: venueId,
    })
  }

  @Post('profile/avatar/upload-url')
  @ApiOperation({ summary: 'Get presigned URL for owner avatar upload' })
  requestOwnerAvatarUploadUrl(@CurrentOwner() owner: { id: string }) {
    return this.media.requestUploadUrl({
      assetType: 'owner_profile',
      ownerId: owner.id,
      entityId: owner.id,
    })
  }

  @Delete('asset')
  @ApiOperation({ summary: 'Delete an R2 asset you own' })
  deleteAsset(
    @CurrentOwner() owner: { id: string },
    @Query() dto: DeleteAssetDto,
  ) {
    return this.media.deleteAsset(dto.assetId, owner.id)
  }
}
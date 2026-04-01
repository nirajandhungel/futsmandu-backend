// apps/owner-api/src/modules/media/media.controller.ts
import {
  Controller, Post, Delete, Get, Body, Param, Query, UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { MediaService } from './media.service.js'
import { OwnerJwtGuard } from '../../common/guards/owner-jwt.guard.js'
import { CurrentOwner } from '../../common/decorators/current-owner.decorator.js'

@ApiTags('Media')
@ApiBearerAuth('Owner-JWT')
@UseGuards(OwnerJwtGuard)
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('venues/:venueId/cover-upload-url')
  @ApiOperation({ summary: 'Get presigned URL to upload venue cover image to R2' })
  getVenueCoverUrl(
    @CurrentOwner() owner: { id: string },
    @Param('venueId') venueId: string,
  ) {
    return this.media.getVenueCoverUploadUrl(owner.id, venueId)
  }

  @Post('venues/:venueId/gallery-upload-url')
  @ApiOperation({ summary: 'Get presigned URL to upload venue gallery image to R2' })
  getVenueGalleryUrl(
    @CurrentOwner() owner: { id: string },
    @Param('venueId') venueId: string,
  ) {
    return this.media.getVenueGalleryUploadUrl(owner.id, venueId)
  }

  @Post('documents/upload-url')
  @ApiOperation({ summary: 'Get presigned URL to upload KYC verification document (private)' })
  getDocumentUrl(
    @CurrentOwner() owner: { id: string },
    @Body('docType') docType: string,
  ) {
    return this.media.getDocumentUploadUrl(owner.id, docType)
  }

  @Post('confirm-upload')
  @ApiOperation({ summary: 'Confirm R2 upload complete — triggers Sharp resize job' })
  confirmUpload(
    @Body('key') key: string,
    @Body('width') width = 1280,
    @Body('height') height = 720,
  ) {
    return this.media.confirmUpload(key, width, height)
  }

  @Delete('object')
  @ApiOperation({ summary: 'Delete an R2 asset (venue images only)' })
  deleteObject(
    @CurrentOwner() owner: { id: string },
    @Query('key') key: string,
  ) {
    return this.media.deleteObject(owner.id, key)
  }
}

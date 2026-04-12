// apps/admin-api/src/modules/media/media.controller.ts

import {
  Controller, Get, Delete,
  Param, ParseUUIDPipe, Query, UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger'
import { MediaService } from '@futsmandu/media'
import { AdminJwtGuard } from '../../common/guards/jwt.guard.js'

@ApiTags('Admin / Media')
@ApiBearerAuth('Admin-JWT')
@UseGuards(AdminJwtGuard)
@Controller('admin/media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  // ── KYC review ────────────────────────────────────────────────────────────

  @Get('owners/:ownerId/kyc/:docType/url')
  @ApiParam({ name: 'ownerId', type: String })
  @ApiParam({ name: 'docType', enum: ['citizenship', 'business_registration', 'business_pan'] })
  @ApiOperation({
    summary: 'Get signed URL to review an owner KYC document',
    description: 'Returns a 10-minute signed GET URL. For admin review workflow.',
  })
  getKycDocUrl(
    @Param('ownerId', ParseUUIDPipe) ownerId: string,
    @Param('docType') docType: string,
  ) {
    return this.media.getKycDocUrl(ownerId, docType, 600)
  }

  // ── Venue verification ────────────────────────────────────────────────────

  @Get('venues/:venueId/verification/url')
  @ApiParam({ name: 'venueId', type: String })
  @ApiQuery({ name: 'key', description: 'Full R2 key of the verification doc', type: String })
  @ApiOperation({ summary: 'Get signed URL to review a venue verification document' })
  getVerificationDocUrl(
    @Param('venueId', ParseUUIDPipe) venueId: string,
    @Query('key') key: string,
  ) {
    return this.media.getVerificationDocUrl(venueId, key, 600)
  }

  // ── Gallery ───────────────────────────────────────────────────────────────

  @Get('venues/:venueId/gallery')
  @ApiParam({ name: 'venueId', type: String })
  @ApiOperation({ summary: 'List venue gallery images with presigned URLs' })
  async getVenueGallery(@Param('venueId', ParseUUIDPipe) venueId: string) {
    const items = await this.media.getGallery(venueId)
    return items.map(img => ({
      asset_id:   img.assetId,
      key:        img.key,
      cdn_url:    img.cdnUrl,
      signed_url: img.signedUrl  ?? null,
      thumb_url:  (img as any).thumbUrl ?? null,
      webp_url:   img.webpUrl    ?? null,
      uploaded_at: img.uploadedAt,
    }))
  }

  // ── Delete (admin moderation) ─────────────────────────────────────────────

  @Delete('asset/:assetId')
  @ApiParam({ name: 'assetId', type: String })
  @ApiOperation({ summary: 'Admin: delete any media asset (moderation)' })
  async deleteAsset(@Param('assetId', ParseUUIDPipe) assetId: string) {
    // Admin bypass: find asset first to get uploaderId, then delete
    // Use a dedicated admin method if you want audit logging
    // For now reuse deleteAsset — pass assetId as both args; service will validate
    // TODO: add MediaService.adminDeleteAsset(assetId) with audit log
    throw new Error('Not implemented — add adminDeleteAsset to MediaService')
  }
}

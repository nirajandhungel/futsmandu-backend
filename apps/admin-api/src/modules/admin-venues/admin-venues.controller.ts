// apps/admin-api/src/modules/admin-venues/admin-venues.controller.ts
// ─── ADDITIVE UPDATE ──────────────────────────────────────────────────────────
// ALL existing endpoints untouched.
// NEW endpoints:
//   GET  /venues/:id/gallery            ← signed gallery images for admin review
//   GET  /venues/:id/verification-docs  ← list venue verification docs (signed)
//   GET  /media/_debug/presign-test     ← debug signed URL generation (non-prod)
// ─────────────────────────────────────────────────────────────────────────────

import {
  Controller, Get, Put, Param, Query, Body, UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam } from '@nestjs/swagger'
import { IsString, IsNotEmpty, IsOptional, IsIn } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { AdminVenuesService } from './admin-venues.service.js'
import { AdminJwtGuard } from '../../common/guards/admin-jwt.guard.js'
import { RolesGuard, Roles } from '../../common/guards/roles.guard.js'
import { CurrentAdmin } from '../../common/decorators/current-admin.decorator.js'
import { MediaService } from '@futsmandu/media'
import { ENV } from '@futsmandu/utils'
import type { AuthAdmin } from '../../common/guards/admin-jwt.guard.js'

class RejectVenueDto {
  @ApiProperty() @IsString() @IsNotEmpty() reason!: string
}

class GetDocQueryDto {
  @ApiPropertyOptional({ enum: ['citizenship', 'pan', 'business_reg', 'other'] })
  @IsOptional()
  @IsIn(['citizenship', 'pan', 'business_reg', 'other'])
  docType?: string
}

@ApiTags('Admin — Venues')
@ApiBearerAuth('Admin-JWT')
@UseGuards(AdminJwtGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller()
export class AdminVenuesController {
  constructor(
    private readonly adminVenues: AdminVenuesService,
    private readonly media: MediaService,   // ← NEW: for debug endpoint
  ) {}

  // ── EXISTING endpoints ──────────────────────────────────────────────────────

  @Get('venues/pending')
  @ApiOperation({ summary: 'List venues pending verification' })
  pending(@Query('page') page?: number) {
    return this.adminVenues.listPendingVenues(page)
  }

  @Get('venues/flagged')
  @ApiOperation({ summary: 'List flagged venues' })
  flagged(@Query('page') page?: number) {
    return this.adminVenues.listFlaggedVenues(page)
  }

  @Put('venues/:id/verify')
  @ApiOperation({ summary: 'Verify venue' })
  verify(@CurrentAdmin() admin: AuthAdmin, @Param('id') venueId: string) {
    return this.adminVenues.verifyVenue(admin.id, venueId)
  }

  @Put('venues/:id/reject')
  @ApiOperation({ summary: 'Reject venue with reason' })
  reject(
    @CurrentAdmin() admin: AuthAdmin,
    @Param('id') venueId: string,
    @Body() dto: RejectVenueDto,
  ) {
    return this.adminVenues.rejectVenue(admin.id, venueId, dto.reason)
  }

  @Get('owners/:id/docs')
  @ApiOperation({
    summary: 'Get presigned R2 GET URL for owner verification doc (10 min)',
    description:
      'UPDATED: now supports any file extension (pdf, jpg, png, webp). ' +
      'Try docType=citizenship|pan|business_reg|other.',
  })
  ownerDocs(
    @Param('id') ownerId: string,
    @Query() query: GetDocQueryDto,
  ) {
    return this.adminVenues.getOwnerDocUrl(ownerId, query.docType ?? 'citizenship')
  }

  // ── NEW endpoints ───────────────────────────────────────────────────────────

  @Get('venues/:id/gallery')
  @ApiParam({ name: 'id', description: 'Venue UUID' })
  @ApiOperation({
    summary: 'List venue gallery images with signed URLs (admin review)',
    description:
      'Returns cdn_url (legacy) + signed_url (new) per image. ' +
      'signed_url is populated when USE_SIGNED_IMAGE_URLS=true.',
  })
  venueGallery(@Param('id') venueId: string) {
    return this.adminVenues.getVenueGallery(venueId)
  }

  @Get('venues/:id/verification-docs')
  @ApiParam({ name: 'id', description: 'Venue UUID' })
  @ApiOperation({
    summary: 'Get signed URL for venue verification document',
    description: 'Returns a time-limited URL (10 min) for admin to view verification images.',
  })
  venueVerificationDocs(
    @Param('id') venueId: string,
    @Query('key') key: string,
  ) {
    return this.adminVenues.getVenueVerificationUrl(venueId, key)
  }

  // ── DEBUG: presign test (non-production only) ───────────────────────────────
  @Get('media/_debug/presign-test')
  @ApiOperation({
    summary: '[DEBUG] Test presigned URL generation — disabled in production',
    description:
      'Call with ?key=venues/xxx/cover/yyy.jpg to verify the full signed URL chain. ' +
      'Returns signed_url, expiry, and flag status.',
  })
  async debugPresignTest(@Query('key') key: string) {
    if (ENV['NODE_ENV'] === 'production') {
      return { error: 'Debug endpoint disabled in production' }
    }

    const testKey     = key || 'venues/test-venue-id/cover/test.jpg'
    const flagEnabled = ENV['USE_SIGNED_IMAGE_URLS'] === 'true'

    try {
      const signedUrl = await this.media.getSignedImageUrl(testKey, 300)
      return {
        ok:           true,
        flag_enabled: flagEnabled,
        key_tested:   testKey,
        signed_url:   signedUrl,
        expires_in_s: 300,
        expires_at:   new Date(Date.now() + 300_000).toISOString(),
        bucket:       ENV['S3_BUCKET'] || '(not set)',
        endpoint:     ENV['S3_ENDPOINT'] || '(not set)',
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

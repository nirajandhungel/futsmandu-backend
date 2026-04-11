// apps/admin-api/src/modules/admin-venues/admin-venues.service.ts
// ─── ADDITIVE UPDATE ──────────────────────────────────────────────────────────
// CHANGED: getOwnerDocUrl() now uses media.getKycDocSignedUrl() — handles any
//          file extension (jpg/png/webp/pdf), not just .pdf.
// CHANGED: getVenueVerificationUrl() now uses media.getVenueVerificationSignedUrl().
// NEW:     listPendingVenues() includes cover_image_signed_url (additive).
// ALL other methods untouched.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Injectable, NotFoundException, Logger,
} from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { MediaService } from '@futsmandu/media'
import { ENV } from '@futsmandu/utils'

function extractKeyFromCdnUrl(cdnUrl: string): string {
  const base = ENV['S3_CDN_BASE_URL'] || ENV['S3_ENDPOINT'] || ''
  if (base && cdnUrl.startsWith(base)) {
    return cdnUrl.slice(base.replace(/\/+$/, '').length + 1)
  }
  try {
    return new URL(cdnUrl).pathname.replace(/^\//, '')
  } catch {
    return cdnUrl
  }
}

@Injectable()
export class AdminVenuesService {
  private readonly logger = new Logger(AdminVenuesService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    @InjectQueue('admin-emails') private readonly emailQueue: Queue,
  ) {}

  async listPendingVenues(page = 1) {
    const PAGE_SIZE = 20
    const skip = (page - 1) * PAGE_SIZE

    const [venues, total] = await Promise.all([
      this.prisma.venues.findMany({
        where: { isApproved: false, is_active: true },
        select: {
          id: true, name: true, slug: true, address: true,
          cover_image_url: true,
          avg_rating: true, total_reviews: true, created_at: true,
          owner: { select: { id: true, name: true, email: true, phone: true, is_verified: true } },
          _count: { select: { courts: true } },
        },
        orderBy: { created_at: 'asc' },
        skip,
        take: PAGE_SIZE,
      }),
      this.prisma.venues.count({ where: { isApproved: false, is_active: true } }),
    ])

    // Additive: signed cover image URL for admin review panel
    const enriched = await Promise.all(
      venues.map(async (v: typeof venues[number]) => {
        const cover_image_signed_url = v.cover_image_url
          ? await this.media.getVenueImageSignedUrl(
              extractKeyFromCdnUrl(v.cover_image_url),
            ).catch(() => null)
          : null
        return { ...v, cover_image_signed_url }
      }),
    )

    return { data: enriched, meta: { page, total } }
  }

  async listFlaggedVenues(page = 1) {
    const PAGE_SIZE = 20
    const skip = (page - 1) * PAGE_SIZE

    const [venues, total] = await Promise.all([
      this.prisma.venues.findMany({
        where: { amenities: { has: 'FLAGGED' } },
        select: {
          id: true, name: true, slug: true, is_verified: true, is_active: true,
          avg_rating: true, total_reviews: true, amenities: true, created_at: true,
          owner: { select: { id: true, name: true, email: true } },
        },
        orderBy: { created_at: 'desc' },
        skip,
        take: PAGE_SIZE,
      }),
      this.prisma.venues.count({ where: { amenities: { has: 'FLAGGED' } } }),
    ])

    return { data: venues, meta: { page, total } }
  }

  async verifyVenue(adminId: string, venueId: string) {
    const venue = await this.prisma.venues.findUnique({
      where: { id: venueId },
      select: {
        id: true, name: true,
        owner: { select: { id: true, email: true, name: true } },
      },
    })
    if (!venue) throw new NotFoundException('Venue not found')

    await this.prisma.venues.update({
      where: { id: venueId },
      data: {
        isApproved:   true,
        approvedAt:   new Date(),
        approvedById: adminId,
        is_verified:  true,
        updated_at:   new Date(),
      },
    })

    await this.prisma.owners.update({
      where: { id: venue.owner.id },
      data: {
        isKycApproved:   true,
        kycApprovedAt:   new Date(),
        kycApprovedById: adminId,
        is_verified:     true,
        updated_at:      new Date(),
      },
    })

    await this.emailQueue
      .add(
        'verification-approved',
        { type: 'verification-approved', to: venue.owner.email, name: venue.owner.name, data: { venueName: venue.name } },
        { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 100, removeOnFail: 200 },
      )
      .catch((e: unknown) => this.logger.error('Email queue error', e))

    this.logger.log(`Venue ${venueId} verified by admin ${adminId}`)
    return { message: 'Venue verified', venueId }
  }

  async rejectVenue(adminId: string, venueId: string, reason: string) {
    const venue = await this.prisma.venues.findUnique({
      where: { id: venueId },
      select: {
        id: true, name: true,
        owner: { select: { id: true, email: true, name: true } },
      },
    })
    if (!venue) throw new NotFoundException('Venue not found')

    await this.prisma.venues.update({
      where: { id: venueId },
      data: {
        isApproved:   false,
        approvedAt:   null,
        approvedById: null,
        is_verified:  false,
        is_active:    false,
        updated_at:   new Date(),
      },
    })

    const remainingApproved = await this.prisma.venues.count({
      where: { owner_id: venue.owner.id, isApproved: true, is_active: true },
    })
    if (remainingApproved === 0) {
      await this.prisma.owners.update({
        where: { id: venue.owner.id },
        data: {
          isKycApproved:   false,
          kycApprovedAt:   null,
          kycApprovedById: null,
          is_verified:     false,
          updated_at:      new Date(),
        },
      })
    }

    await this.emailQueue
      .add(
        'verification-rejected',
        { type: 'verification-rejected', to: venue.owner.email, name: venue.owner.name, data: { venueName: venue.name, reason } },
        { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 100, removeOnFail: 200 },
      )
      .catch((e: unknown) => this.logger.error('Email queue error', e))

    this.logger.log(`Venue ${venueId} rejected by admin ${adminId}: ${reason}`)
    return { message: 'Venue rejected', venueId }
  }

  // ── Admin-only: signed GET URL for KYC doc ─────────────────────────────────
  // UPDATED: now uses getKycDocSignedUrl which handles any file extension
  async getOwnerDocUrl(ownerId: string, docType: string): Promise<{ downloadUrl: string; expiresIn: number }> {
    return this.media.getKycDocSignedUrl(ownerId, docType, 600)
  }

  // ── Admin venue verification image ─────────────────────────────────────────
  // UPDATED: now uses getVenueVerificationSignedUrl
  async getVenueVerificationUrl(venueId: string, key: string): Promise<{ downloadUrl: string; expiresIn: number }> {
    return this.media.getVenueVerificationSignedUrl(venueId, key, 600)
  }

  // ── Admin: list venue gallery (with signed URLs for admin review) ───────────
  async getVenueGallery(venueId: string): Promise<Array<{
    asset_id: string
    cdn_url: string
    signed_url: string | null
    webp_url: string | null
    uploaded_at: Date
  }>> {
    const images = await this.media.getGallerySignedUrls(venueId)
    return images.map(img => ({
      asset_id:    img.assetId,
      cdn_url:     img.cdnUrl,
      signed_url:  img.signedUrl ?? null,
      webp_url:    img.webpUrl ?? null,
      uploaded_at: img.uploadedAt,
    }))
  }
}

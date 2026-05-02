// apps/admin-api/src/modules/admin-venues/admin-venues.service.ts
// ─── SCHEMA FIX ───────────────────────────────────────────────────────────────
// venues:  isApproved → is_verified, approvedAt → approved_at, approvedById → approved_by_id
// owners:  isKycApproved → is_kyc_approved, kycApprovedAt → kyc_approved_at,
//          kycApprovedById → kyc_approved_by_id
// All field names are now aligned with the Prisma schema (snake_case throughout).
// ─────────────────────────────────────────────────────────────────────────────

import {
  Injectable, NotFoundException, Logger,
} from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { MediaService, extractKeyFromCdnUrl } from '@futsmandu/media'
import { ENV } from '@futsmandu/utils'

@Injectable()
export class AdminVenuesService {
  private readonly logger = new Logger(AdminVenuesService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    @InjectQueue('admin-emails') private readonly emailQueue: Queue,
  ) { }

  async listAllVenues(page = 1) {
    const PAGE_SIZE = 20
    const skip = (page - 1) * PAGE_SIZE

    const [venues, total] = await Promise.all([
      this.prisma.venues.findMany({
        select: {
          id: true, name: true, slug: true, is_verified: true, is_active: true,
          cover_image_url: true,
          avg_rating: true, total_reviews: true, amenities: true, created_at: true,
          owner: { select: { id: true, name: true, email: true } },
        },
        orderBy: { created_at: 'desc' },
        skip,
        take: PAGE_SIZE,
      }),
      this.prisma.venues.count({
      })
    ])

    const enriched = await Promise.all(
      venues.map(async (v: typeof venues[number]) => {
        const cover_image_signed_url = v.cover_image_url
          ? await this.media.getImageUrl(
            extractKeyFromCdnUrl(v.cover_image_url),
          ).catch(() => null)
          : null
        return { ...v, cover_image_signed_url }
      }),
    )

    return { data: enriched, meta: { page, total } }
  }
  
  async listPendingVenues(page = 1) {
    const PAGE_SIZE = 20
    const skip = (page - 1) * PAGE_SIZE

    // Pending = not yet verified (is_verified: false) and still active
    const [venues, total] = await Promise.all([
      this.prisma.venues.findMany({
        where: { is_verified: false, is_active: true },   // ← was: isApproved (does not exist)
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
      this.prisma.venues.count({ where: { is_verified: false, is_active: true } }),
    ])

    // Signed cover image URL for admin review panel
    const enriched = await Promise.all(
      venues.map(async (v: typeof venues[number]) => {
        const cover_image_signed_url = v.cover_image_url
          ? await this.media.getImageUrl(
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
        is_verified: true,          // ← was: isApproved (does not exist)
        approved_at: new Date(),    // ← was: approvedAt
        approved_by_id: adminId,       // ← was: approvedById
        updated_at: new Date(),
      },
    })

    await this.prisma.owners.update({
      where: { id: venue.owner.id },
      data: {
        is_kyc_approved: true,      // ← was: isKycApproved (does not exist)
        kyc_approved_at: new Date(), // ← was: kycApprovedAt
        kyc_approved_by_id: adminId,   // ← was: kycApprovedById
        is_verified: true,
        updated_at: new Date(),
      },
    })

    await this.emailQueue
      .add(
        'verification-approved',
        {
          type: 'verification-approved',
          to: venue.owner.email,
          name: venue.owner.name,
          data: { venueName: venue.name },
        },
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
        is_verified: false,   // ← was: isApproved
        approved_at: null,    // ← was: approvedAt
        approved_by_id: null,    // ← was: approvedById
        is_active: false,
        updated_at: new Date(),
      },
    })

    // Revoke owner KYC only if no other approved venues remain
    const remainingApproved = await this.prisma.venues.count({
      where: { owner_id: venue.owner.id, is_verified: true, is_active: true }, // ← was: isApproved
    })
    if (remainingApproved === 0) {
      await this.prisma.owners.update({
        where: { id: venue.owner.id },
        data: {
          is_kyc_approved: false,  // ← was: isKycApproved
          kyc_approved_at: null,   // ← was: kycApprovedAt
          kyc_approved_by_id: null,   // ← was: kycApprovedById
          is_verified: false,
          updated_at: new Date(),
        },
      })
    }

    await this.emailQueue
      .add(
        'verification-rejected',
        {
          type: 'verification-rejected',
          to: venue.owner.email,
          name: venue.owner.name,
          data: { venueName: venue.name, reason },
        },
        { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 100, removeOnFail: 200 },
      )
      .catch((e: unknown) => this.logger.error('Email queue error', e))

    this.logger.log(`Venue ${venueId} rejected by admin ${adminId}: ${reason}`)
    return { message: 'Venue rejected', venueId }
  }

  // ── Admin-only: signed GET URL for KYC doc ─────────────────────────────────
  async getOwnerDocUrl(ownerId: string, docType: string): Promise<{ downloadUrl: string; expiresIn: number }> {
    return this.media.getKycDocUrl(ownerId, docType, 600)
  }

  // ── Admin venue verification image ─────────────────────────────────────────
  async getVenueVerificationUrl(venueId: string, key: string): Promise<{ downloadUrl: string; expiresIn: number }> {
    return this.media.getVerificationDocUrl(venueId, key, 600)
  }

  // ── Admin: list venue gallery (with signed URLs for admin review) ───────────
  async getVenueGallery(venueId: string): Promise<Array<{
    asset_id: string
    cdn_url: string
    signed_url: string | null
    webp_url: string | null
    uploaded_at: Date
  }>> {
    const images = await this.media.getGallery(venueId)
    return images.map((img: any) => ({
      asset_id: img.assetId,
      cdn_url: img.cdnUrl,
      signed_url: img.signedUrl ?? null,
      webp_url: img.webpUrl ?? null,
      uploaded_at: img.uploadedAt,
    }))
  }
}
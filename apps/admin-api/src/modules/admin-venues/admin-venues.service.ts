// apps/admin-api/src/modules/admin-venues/admin-venues.service.ts
// CHANGED: Removed inline S3Client instantiation in getOwnerDocUrl().
// Now delegates to @futsmandu/media MediaService.getSignedDownloadUrl().

import {
  Injectable, NotFoundException, Logger,
} from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { MediaService } from '@futsmandu/media'

@Injectable()
export class AdminVenuesService {
  private readonly logger = new Logger(AdminVenuesService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,   // ← replaces inline S3 code
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

    return { data: venues, meta: { page, total } }
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

  // ── Admin-only: signed GET URL for private KYC doc ────────────────────────
  // CHANGED: no more inline S3Client — delegates to shared MediaService
  async getOwnerDocUrl(ownerId: string, docType: string): Promise<{ downloadUrl: string; expiresIn: number }> {
    const key = `owners/${ownerId}/kyc/${docType}.pdf`
    return this.media.getSignedDownloadUrl({ key, expiresIn: 600 })
  }

  // Admin can also access venue verification images
  async getVenueVerificationUrl(venueId: string, key: string): Promise<{ downloadUrl: string; expiresIn: number }> {
    // Key must be under venues/{venueId}/verification/
    if (!key.startsWith(`venues/${venueId}/verification/`)) {
      throw new NotFoundException('Verification image not found for this venue')
    }
    return this.media.getSignedDownloadUrl({ key, expiresIn: 600 })
  }
}
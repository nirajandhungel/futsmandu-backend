import {
  Injectable, NotFoundException, Logger,
} from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { ENV } from '@futsmandu/utils'

@Injectable()
export class AdminVenuesService {
  private readonly logger = new Logger(AdminVenuesService.name)

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('admin-emails') private readonly emailQueue: Queue,
  ) { }

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
    // Flagged venues — stored as a tag in a future "flags" table.
    // For now, we use amenities array containing 'FLAGGED' as sentinel.
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
        isApproved: true,
        approvedAt: new Date(),
        approvedById: adminId,
        // Legacy field kept in sync for owner-api compatibility during migration
        is_verified: true,
        updated_at: new Date(),
      },
    })

    // Approving a venue implies approving the owning account KYC (syncing legacy is_verified too).
    await this.prisma.owners.update({
      where: { id: venue.owner.id },
      data: {
        isKycApproved: true,
        kycApprovedAt: new Date(),
        kycApprovedById: adminId,
        // Legacy field kept in sync for owner-api compatibility
        is_verified: true,
        updated_at: new Date(),
      },
    })

    // Notify owner
    await this.emailQueue
      .add('verification-approved', {
        type: 'verification-approved',
        to: venue.owner.email,
        name: venue.owner.name,
        data: { venueName: venue.name },
      })
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
        isApproved: false,
        approvedAt: null,
        approvedById: null,
        // Legacy field kept in sync for owner-api compatibility during migration
        is_verified: false,
        is_active: false,
        updated_at: new Date(),
      },
    })

    // If the owner has no other approved venues left, revoke owner KYC (legacy + new fields).
    const remainingApproved = await this.prisma.venues.count({
      where: { owner_id: venue.owner.id, isApproved: true, is_active: true },
    })
    if (remainingApproved === 0) {
      await this.prisma.owners.update({
        where: { id: venue.owner.id },
        data: {
          isKycApproved: false,
          kycApprovedAt: null,
          kycApprovedById: null,
          // Legacy field kept in sync for owner-api compatibility
          is_verified: false,
          updated_at: new Date(),
        },
      })
    }

    await this.emailQueue
      .add('verification-rejected', {
        type: 'verification-rejected',
        to: venue.owner.email,
        name: venue.owner.name,
        data: { venueName: venue.name, reason },
      })
      .catch((e: unknown) => this.logger.error('Email queue error', e))

    this.logger.log(`Venue ${venueId} rejected by admin ${adminId}: ${reason}`)
    return { message: 'Venue rejected', venueId }
  }

  async getOwnerDocUrl(ownerId: string, docType: string): Promise<{ downloadUrl: string }> {
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3')
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')

    const s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${ENV['CF_ACCOUNT_ID']}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: ENV['R2_ACCESS_KEY_ID'] as string,
        secretAccessKey: ENV['R2_SECRET_ACCESS_KEY'] as string,
      },
    })

    const key = `verify/${ownerId}/${docType}.pdf`
    const command = new GetObjectCommand({
      Bucket: ENV['R2_BUCKET_NAME'],
      Key: key,
    })

    const downloadUrl = await getSignedUrl(s3, command, { expiresIn: 600 }) // 10 min
    return { downloadUrl }
  }
}

// Venue management service — CRUD for venues, courts, and image uploads.
// Every query scoped to owner_id — never returns another owner's data.
import {
  Injectable, NotFoundException, ConflictException, Logger,
} from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import type { Prisma } from '@futsmandu/database'
import type { CreateVenueDto, UpdateVenueDto, CreateCourtDto, UpdateCourtDto } from './dto/venue.dto.js'
import { ENV } from '@futsmandu/utils'

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-') +
    '-' +
    Date.now().toString(36)
  )
}

@Injectable()
export class VenueManagementService {
  private readonly logger = new Logger(VenueManagementService.name)

  constructor(private readonly prisma: PrismaService) {}

  // ── Venues ─────────────────────────────────────────────────────────────────
  async listVenues(ownerId: string) {
    return this.prisma.venues.findMany({
      where:   { owner_id: ownerId, is_active: true },
      select: {
        id: true, name: true, slug: true, description: true,
        address: true, latitude: true, longitude: true,
        amenities: true, cover_image_url: true,
        is_verified: true, avg_rating: true, total_reviews: true,
        full_refund_hours: true, partial_refund_hours: true, partial_refund_pct: true,
        created_at: true, updated_at: true,
        _count: { select: { courts: true } },
      },
      orderBy: { created_at: 'desc' },
    })
  }

  async createVenue(ownerId: string, dto: CreateVenueDto) {
    const slug = slugify(dto.name)
    return this.prisma.venues.create({
      data: {
        owner_id:             ownerId,
        name:                 dto.name,
        slug,
        description:          dto.description,
        address:              dto.address as unknown as Prisma.InputJsonValue,
        latitude:             dto.latitude,
        longitude:            dto.longitude,
        amenities:            dto.amenities ?? [],
        full_refund_hours:    dto.full_refund_hours ?? 24,
        partial_refund_hours: dto.partial_refund_hours ?? 6,
        partial_refund_pct:   dto.partial_refund_pct ?? 50,
      },
      select: {
        id: true, name: true, slug: true, is_verified: true, created_at: true,
      },
    })
  }

  async updateVenue(ownerId: string, venueId: string, dto: UpdateVenueDto) {
    await this.assertVenueOwnership(venueId, ownerId)
    const { address, ...rest } = dto
    return this.prisma.venues.update({
      where: { id: venueId },
      data:  {
        ...rest,
        ...(address !== undefined ? { address: address as unknown as Prisma.InputJsonValue } : {}),
        updated_at: new Date(),
      },
      select: {
        id: true, name: true, slug: true, address: true,
        amenities: true, updated_at: true,
      },
    })
  }

  // ── Courts ─────────────────────────────────────────────────────────────────
  async listCourts(ownerId: string, venueId: string) {
    await this.assertVenueOwnership(venueId, ownerId)
    return this.prisma.courts.findMany({
      where:   { venue_id: venueId, is_active: true },
      select: {
        id: true, name: true, court_type: true, surface: true,
        capacity: true, min_players: true, slot_duration_mins: true,
        open_time: true, close_time: true, created_at: true,
        _count: { select: { pricing_rules: true } },
      },
      orderBy: { created_at: 'asc' },
    })
  }

  async createCourt(ownerId: string, venueId: string, dto: CreateCourtDto) {
    await this.assertVenueOwnership(venueId, ownerId)
    return this.prisma.courts.create({
      data: {
        venue_id:           venueId,
        name:               dto.name,
        court_type:         dto.court_type ?? '5v5',
        surface:            dto.surface    ?? 'turf',
        capacity:           dto.capacity   ?? 10,
        min_players:        dto.min_players ?? 4,
        slot_duration_mins: dto.slot_duration_mins ?? 60,
        open_time:          dto.open_time  ?? '06:00',
        close_time:         dto.close_time ?? '22:00',
      },
      select: {
        id: true, name: true, court_type: true, slot_duration_mins: true, created_at: true,
      },
    })
  }

  async updateCourt(ownerId: string, courtId: string, dto: UpdateCourtDto) {
    await this.assertCourtOwnership(courtId, ownerId)
    return this.prisma.courts.update({
      where: { id: courtId },
      data:  { ...dto },
      select: { id: true, name: true, open_time: true, close_time: true },
    })
  }

  async softDeleteCourt(ownerId: string, courtId: string) {
    await this.assertCourtOwnership(courtId, ownerId)

    // Guard: refuse if there are active future bookings
    const activeBookings = await this.prisma.bookings.count({
      where: {
        court_id:     courtId,
        status:       { in: ['HELD', 'PENDING_PAYMENT', 'CONFIRMED'] },
        booking_date: { gte: new Date() },
      },
    })
    if (activeBookings > 0) {
      throw new ConflictException('Cannot deactivate court with active upcoming bookings')
    }

    await this.prisma.courts.update({
      where: { id: courtId },
      data:  { is_active: false },
    })
    return { message: 'Court deactivated successfully' }
  }

  // ── Cover Image Upload ─────────────────────────────────────────────────────
  async getImageUploadUrl(
    ownerId: string,
    venueId: string,
  ): Promise<{ uploadUrl: string; cdnUrl: string }> {
    await this.assertVenueOwnership(venueId, ownerId)

    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3')
    const { getSignedUrl }              = await import('@aws-sdk/s3-request-presigner')

    const s3 = new S3Client({
      region:   'auto',
      endpoint: `https://${ENV['CF_ACCOUNT_ID']}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId:     ENV['R2_ACCESS_KEY_ID'],
        secretAccessKey: ENV['R2_SECRET_ACCESS_KEY'],
      },
    })

    const key = `venues/${venueId}/cover.jpg`
    const cmd = new PutObjectCommand({
      Bucket:       ENV['R2_BUCKET_NAME'],
      Key:          key,
      ContentType:  'image/jpeg',
      CacheControl: 'public, max-age=86400',
    })

    const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 600 })
    const cdnUrl    = `${ENV['R2_CDN_BASE_URL']}/${key}`

    // Pre-store CDN URL — client uploads and it becomes live
    await this.prisma.venues.update({
      where: { id: venueId },
      data:  { cover_image_url: cdnUrl, updated_at: new Date() },
    })

    return { uploadUrl, cdnUrl }
  }

  // ── Ownership guards ───────────────────────────────────────────────────────
  private async assertVenueOwnership(venueId: string, ownerId: string): Promise<void> {
    const venue = await this.prisma.venues.findFirst({
      where:  { id: venueId, owner_id: ownerId },
      select: { id: true },
    })
    if (!venue) throw new NotFoundException('Venue not found or access denied')
  }

  private async assertCourtOwnership(courtId: string, ownerId: string): Promise<void> {
    const court = await this.prisma.courts.findFirst({
      where:  { id: courtId, venue: { owner_id: ownerId } },
      select: { id: true },
    })
    if (!court) throw new NotFoundException('Court not found or access denied')
  }
}

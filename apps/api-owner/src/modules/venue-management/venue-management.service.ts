// apps/owner-api/src/modules/venue-management/venue-management.service.ts
// OPTIMIZED: listGalleryImages() queries via venue_media link table (correct schema pattern).
// Gallery cache is invalidated by MediaService after new uploads.

import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common'

import { PrismaService } from '@futsmandu/database'
import type { Prisma } from '@futsmandu/database'
import { venue_media_type } from '@futsmandu/database'

import type {
  CreateVenueDto,
  UpdateVenueDto,
  CreateCourtDto,
  UpdateCourtDto,
} from './dto/venue.dto.js'

import { ENV } from '@futsmandu/utils'

/* ───────────────── UUID VALIDATION ───────────────── */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validateUuid(value: string, label = 'ID'): void {
  if (!UUID_RE.test(value)) {
    throw new BadRequestException(
      `Invalid ${label} — must be a valid UUID`,
    )
  }
}

/* ───────────────── HELPERS ───────────────── */

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

function formatCdnUrl(base: string, key: string): string {
  const cleanBase = base.replace(/\/+$/, '')
  const cleanKey = key.replace(/^\/+/, '')

  return cleanBase
    ? `${cleanBase}/${cleanKey}`
    : cleanKey
}

/* ───────────────── TYPES ───────────────── */

// venue_media row with media relation selected — used in listGalleryImages
type VenueMediaRow = {
  display_order: number
  media: {
    id:         string
    file_key:   string
    webp_key:   string | null
    thumb_key:  string | null
    created_at: Date
  }
}

/* ───────────────── SERVICE ───────────────── */

@Injectable()
export class VenueManagementService {

  private readonly logger = new Logger(
    VenueManagementService.name,
  )

  private readonly cdnBase: string

  constructor(
    private readonly prisma: PrismaService,
  ) {
    this.cdnBase =
      (
        ENV['S3_CDN_BASE_URL'] ||
        ENV['S3_ENDPOINT'] ||
        ''
      ).replace(/\/+$/, '')
  }

  /* ───────────────── VENUES ───────────────── */

  async listVenues(ownerId: string) {
    return this.prisma.venues.findMany({
      where: {
        owner_id: ownerId,
        is_active: true,
      },

      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        address: true,
        latitude: true,
        longitude: true,
        amenities: true,
        cover_image_url: true,
        is_verified: true,
        avg_rating: true,
        total_reviews: true,
        full_refund_hours: true,
        partial_refund_hours: true,
        partial_refund_pct: true,
        created_at: true,
        updated_at: true,

        _count: {
          select: { courts: true },
        },
      },

      orderBy: {
        created_at: 'desc',
      },
    })
  }

  async createVenue(
    ownerId: string,
    dto: CreateVenueDto,
  ) {
    const slug = slugify(dto.name)

    return this.prisma.venues.create({
      data: {
        owner_id: ownerId,
        name: dto.name,
        slug,

        description: dto.description,

        address:
          dto.address as unknown as Prisma.InputJsonValue,

        latitude: dto.latitude,
        longitude: dto.longitude,

        amenities: dto.amenities ?? [],

        full_refund_hours:
          dto.full_refund_hours ?? 24,

        partial_refund_hours:
          dto.partial_refund_hours ?? 6,

        partial_refund_pct:
          dto.partial_refund_pct ?? 50,
      },

      select: {
        id: true,
        name: true,
        slug: true,
        is_verified: true,
        created_at: true,
      },
    })
  }

  async updateVenue(
    ownerId: string,
    venueId: string,
    dto: UpdateVenueDto,
  ) {
    await this.assertVenueOwnership(
      venueId,
      ownerId,
    )

    const { address, ...rest } = dto

    return this.prisma.venues.update({
      where: { id: venueId },

      data: {
        ...rest,

        ...(address !== undefined
          ? {
              address:
                address as unknown as Prisma.InputJsonValue,
            }
          : {}),

        updated_at: new Date(),
      },

      select: {
        id: true,
        name: true,
        slug: true,
        address: true,
        amenities: true,
        updated_at: true,
      },
    })
  }

  /* ───────────────── COURTS ───────────────── */

  async listCourts(
    ownerId: string,
    venueId: string,
  ) {
    await this.assertVenueOwnership(
      venueId,
      ownerId,
    )

    return this.prisma.courts.findMany({
      where: {
        venue_id: venueId,
        is_active: true,
      },

      select: {
        id: true,
        name: true,
        court_type: true,
        surface: true,
        capacity: true,
        min_players: true,
        slot_duration_mins: true,
        open_time: true,
        close_time: true,
        created_at: true,

        _count: {
          select: {
            pricing_rules: true,
          },
        },
      },

      orderBy: {
        created_at: 'asc',
      },
    })
  }

  async createCourt(
    ownerId: string,
    venueId: string,
    dto: CreateCourtDto,
  ) {
    await this.assertVenueOwnership(
      venueId,
      ownerId,
    )

    return this.prisma.$transaction(async (tx: any) => {
      const court = await tx.courts.create({
        data: {
          venue_id: venueId,
          name: dto.name,
          court_type: dto.court_type ?? '5v5',
          surface: dto.surface ?? 'turf',
          capacity: dto.capacity ?? 10,
          min_players: dto.min_players ?? 4,
          slot_duration_mins: dto.slot_duration_mins ?? 60,
          open_time: dto.open_time ?? '06:00',
          close_time: dto.close_time ?? '22:00',
        },
        select: {
          id: true,
          name: true,
          court_type: true,
          slot_duration_mins: true,
          created_at: true,
        },
      })

      await tx.pricing_rules.create({
        data: {
          court_id: court.id,
          rule_type: 'base',
          priority: 1,
          price: dto.base_price,
          modifier: 'fixed',
          days_of_week: [],
          start_time: null,
          end_time: null,
          date_from: null,
          date_to: null,
          hours_before: null,
          is_active: true,
        },
      })

      return {
        ...court,
        base_price: dto.base_price,
      }
    })
  }

  async updateCourt(
    ownerId: string,
    courtId: string,
    dto: UpdateCourtDto,
  ) {
    await this.assertCourtOwnership(
      courtId,
      ownerId,
    )

    return this.prisma.courts.update({
      where: { id: courtId },

      data: { ...dto },

      select: {
        id: true,
        name: true,
        open_time: true,
        close_time: true,
      },
    })
  }

  async softDeleteCourt(
    ownerId: string,
    courtId: string,
  ) {
    await this.assertCourtOwnership(
      courtId,
      ownerId,
    )

    const activeBookings =
      await this.prisma.bookings.count({
        where: {
          court_id: courtId,

          status: {
            in: [
              'HELD',
              'PENDING_PAYMENT',
              'CONFIRMED',
            ],
          },

          booking_date: {
            gte: new Date(),
          },
        },
      })

    if (activeBookings > 0) {
      throw new ConflictException(
        'Cannot deactivate court with active upcoming bookings',
      )
    }

    await this.prisma.courts.update({
      where: { id: courtId },

      data: {
        is_active: false,
      },
    })

    return {
      message:
        'Court deactivated successfully',
    }
  }

  /* ───────────────── GALLERY ───────────────── */

  async listGalleryImages(
    ownerId: string,
    venueId: string,
  ) {
    await this.assertVenueOwnership(
      venueId,
      ownerId,
    )

    // Query via venue_media link table → JOIN media_assets
    // venue_id index → fast lookup; status filter keeps only ready images
    const links = await this.prisma.venue_media.findMany({
      where: {
        venue_id: venueId,
        type:     venue_media_type.GALLERY,
        media: {
          status:     'completed',
          deleted_at: null,
        },
      },
      select: {
        display_order: true,
        media: {
          select: {
            id:         true,
            file_key:   true,
            webp_key:   true,
            thumb_key:  true,
            created_at: true,
          },
        },
      },
      orderBy: [
        { display_order: 'asc' },
        { created_at:    'desc' },
      ],
    })

    return links.map((l: VenueMediaRow) => ({
      assetId: l.media.id,

      cdnUrl: formatCdnUrl(
        this.cdnBase,
        l.media.file_key,
      ),

      webpUrl: l.media.webp_key
        ? formatCdnUrl(this.cdnBase, l.media.webp_key)
        : undefined,

      /** 320×240 — use in grid view */
      thumbUrl: l.media.thumb_key
        ? formatCdnUrl(this.cdnBase, l.media.thumb_key)
        : undefined,

      uploadedAt: l.media.created_at,
    }))
  }

  /* ───────────────── OWNERSHIP ───────────────── */

  private async assertVenueOwnership(
    venueId: string,
    ownerId: string,
  ): Promise<void> {

    validateUuid(
      venueId,
      'venue ID',
    )

    const venue =
      await this.prisma.venues.findFirst({
        where: {
          id: venueId,
          owner_id: ownerId,
        },

        select: {
          id: true,
        },
      })

    if (!venue) {
      throw new NotFoundException(
        'Venue not found or access denied',
      )
    }
  }

  private async assertCourtOwnership(
    courtId: string,
    ownerId: string,
  ): Promise<void> {

    validateUuid(
      courtId,
      'court ID',
    )

    const court =
      await this.prisma.courts.findFirst({
        where: {
          id: courtId,

          venue: {
            owner_id: ownerId,
          },
        },

        select: {
          id: true,
        },
      })

    if (!court) {
      throw new NotFoundException(
        'Court not found or access denied',
      )
    }
  }
}
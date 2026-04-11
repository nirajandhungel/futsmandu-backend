// apps/player-api/src/modules/venue/venue.service.ts
// ─── ADDITIVE UPDATE ──────────────────────────────────────────────────────────
// CHANGED: list() and detail() now include cover_image_signed_url alongside
//          existing cover_image_url (backward compat, feature-flagged).
// Gallery images in detail() include signed_url when flag is on.
// Review player profile_image_url is NOT signed (public CDN asset — fast).
// ALL existing methods and response fields are preserved.
// ─────────────────────────────────────────────────────────────────────────────

import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
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
export class VenueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,   // ← NEW injection
  ) {}

  async list(q?: string, page = 1, limit = 20) {
    const take = Math.min(limit, 50)
    const venues = await this.prisma.venues.findMany({
      where: { is_active: true, is_verified: true, ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) },
      select: {
        id: true, name: true, slug: true, description: true, address: true,
        latitude: true, longitude: true, cover_image_url: true,
        avg_rating: true, total_reviews: true, amenities: true,
        courts: {
          where:  { is_active: true },
          select: { id: true, name: true, court_type: true, surface: true, slot_duration_mins: true },
        },
      },
      skip: (page - 1) * take, take,
      orderBy: [{ avg_rating: 'desc' }, { total_reviews: 'desc' }],
    })

    // Additive: signed URL for cover image
    return Promise.all(
      venues.map(async (v: typeof venues[number]) => {
        const cover_image_signed_url = v.cover_image_url
          ? await this.media.getVenueImageSignedUrl(
              extractKeyFromCdnUrl(v.cover_image_url),
            ).catch(() => null)
          : null

        return {
          ...v,
          cover_image_url:        v.cover_image_url,   // legacy — unchanged
          cover_image_signed_url,      // new — null when flag off
        }
      }),
    )
  }

  async detail(id: string) {
    const venue = await this.prisma.venues.findUnique({
      where: { id, is_active: true, is_verified: true },
      include: {
        courts: {
          where:  { is_active: true },
          select: {
            id: true, name: true, court_type: true, surface: true,
            capacity: true, min_players: true, slot_duration_mins: true,
            open_time: true, close_time: true,
          },
        },
        reviews: {
          where:   { is_approved: true },
          orderBy: { created_at: 'desc' },
          take:    10,
          select: {
            id: true, rating: true, comment: true, owner_reply: true, created_at: true,
            player: { select: { name: true, profile_image_url: true } },
          },
        },
      },
    })
    if (!venue) throw new NotFoundException('Venue not found')

    // Signed cover URL
    const cover_image_signed_url = venue.cover_image_url
      ? await this.media.getVenueImageSignedUrl(
          extractKeyFromCdnUrl(venue.cover_image_url),
        ).catch(() => null)
      : null

    // Gallery images with signed URLs
    const gallery = await this.media.getGallerySignedUrls(id)
    const gallery_images = gallery.map(img => ({
      asset_id:   img.assetId,
      cdn_url:    img.cdnUrl,
      signed_url: img.signedUrl ?? null,
      webp_url:   img.webpUrl ?? null,
    }))

    return {
      ...venue,
      cover_image_url:        venue.cover_image_url,   // legacy — unchanged
      cover_image_signed_url,                           // new
      gallery_images,                                   // new — structured gallery
    }
  }

  async writeReview(venueId: string, playerId: string, bookingId: string, rating: number, comment?: string) {
    const booking = await this.prisma.bookings.findUnique({
      where:  { id: bookingId },
      select: { player_id: true, venue_id: true, status: true },
    })
    if (!booking)                           throw new NotFoundException('Booking not found')
    if (booking.player_id !== playerId)     throw new BadRequestException('Not your booking')
    if (booking.venue_id !== venueId)       throw new BadRequestException('Venue mismatch')
    if (booking.status !== 'COMPLETED')     throw new BadRequestException('Can only review completed bookings')

    const existing = await this.prisma.reviews.findUnique({ where: { booking_id: bookingId } })
    if (existing) throw new ConflictException('You have already reviewed this booking')

    return this.prisma.reviews.create({
      data: { booking_id: bookingId, venue_id: venueId, player_id: playerId, rating, comment: comment ?? null },
    })
  }
}

// apps/player-api/src/modules/venue/venue.service.ts
import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'

@Injectable()
export class VenueService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q?: string, page = 1, limit = 20) {
    const take = Math.min(limit, 50)
    return this.prisma.venues.findMany({
      where: { is_active: true, is_verified: true, ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) },
      select: {
        id: true, name: true, slug: true, description: true, address: true,
        latitude: true, longitude: true, cover_image_url: true,
        avg_rating: true, total_reviews: true, amenities: true,
        courts: { where: { is_active: true }, select: { id: true, name: true, court_type: true, surface: true, slot_duration_mins: true } },
      },
      skip: (page - 1) * take, take,
      orderBy: [{ avg_rating: 'desc' }, { total_reviews: 'desc' }],
    })
  }

  async detail(id: string) {
    const venue = await this.prisma.venues.findUnique({
      where: { id, is_active: true, is_verified: true },
      include: {
        courts: { where: { is_active: true }, select: { id: true, name: true, court_type: true, surface: true, capacity: true, min_players: true, slot_duration_mins: true, open_time: true, close_time: true } },
        reviews: { where: { is_approved: true }, orderBy: { created_at: 'desc' }, take: 10, select: { id: true, rating: true, comment: true, owner_reply: true, created_at: true, player: { select: { name: true, profile_image_url: true } } } },
      },
    })
    if (!venue) throw new NotFoundException('Venue not found')
    return venue
  }

  async writeReview(venueId: string, playerId: string, bookingId: string, rating: number, comment?: string) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
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

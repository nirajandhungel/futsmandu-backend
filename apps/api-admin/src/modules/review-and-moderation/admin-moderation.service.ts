// Review moderation — approve/reject reviews, recalculate avg_rating.
// avg_rating recalculation: always from all approved reviews, never stored sum.
import {
  Injectable, NotFoundException, Logger,
} from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import type { PrismaClient } from '@futsmandu/database'

type PrismaTx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

@Injectable()
export class AdminModerationService {
  private readonly logger = new Logger(AdminModerationService.name)

  constructor(private readonly prisma: PrismaService) {}

  async listPendingReviews(page = 1) {
    const PAGE_SIZE = 25
    const skip      = (page - 1) * PAGE_SIZE

    const [reviews, total] = await Promise.all([
      this.prisma.reviews.findMany({
        where:   { is_approved: false },
        select: {
          id: true, rating: true, comment: true, owner_reply: true,
          is_approved: true, created_at: true,
          player: { select: { id: true, name: true, reliability_score: true } },
          venue:  { select: { id: true, name: true } },
        },
        orderBy: { created_at: 'asc' },
        skip,
        take: PAGE_SIZE,
      }),
      this.prisma.reviews.count({ where: { is_approved: false } }),
    ])

    return { data: reviews, meta: { page, total } }
  }

  async approveReview(adminId: string, reviewId: string) {
    const review = await this.prisma.reviews.findUnique({
      where: { id: reviewId },
      select: { id: true, venue_id: true, is_approved: true },
    })
    if (!review) throw new NotFoundException('Review not found')

    await this.prisma.$transaction(async (tx: PrismaTx) => {
      await tx.reviews.update({
        where: { id: reviewId },
        data:  { is_approved: true },
      })
      await this.recalcVenueRating(tx, review.venue_id)
    })

    this.logger.log(`Review ${reviewId} approved by admin ${adminId}`)
    return { message: 'Review approved', reviewId }
  }

  async deleteReview(adminId: string, reviewId: string) {
    const review = await this.prisma.reviews.findUnique({
      where: { id: reviewId },
      select: { id: true, venue_id: true, is_approved: true },
    })
    if (!review) throw new NotFoundException('Review not found')

    await this.prisma.reviews.delete({ where: { id: reviewId } })

    // Only recalc if the deleted review was approved (it was affecting the average)
    if (review.is_approved) {
      await this.recalcVenueRating(this.prisma, review.venue_id)
    }

    this.logger.log(`Review ${reviewId} deleted by admin ${adminId}`)
    return { message: 'Review deleted', reviewId }
  }

  // ── avg_rating recalc — always from all approved reviews, never cached sum ──
  private async recalcVenueRating(tx: PrismaTx | PrismaService, venueId: string): Promise<void> {
    const { _avg, _count } = await tx.reviews.aggregate({
      where:  { venue_id: venueId, is_approved: true },
      _avg:   { rating: true },
      _count: { rating: true },
    })

    await tx.venues.update({
      where: { id: venueId },
      data: {
        avg_rating:   _avg.rating ?? 0,
        total_reviews: _count.rating,
        updated_at:   new Date(),
      },
    })
  }
}
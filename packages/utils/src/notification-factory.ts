// packages/utils/src/notification-factory.ts
import type { NotificationPayload } from '@futsmandu/types'

export class NotificationFactory {
  static build(type: string, ctx: Record<string, unknown>): NotificationPayload {
    switch (type) {
      case 'BOOKING_CONFIRMED':
        return {
          title: '✅ Booking Confirmed!',
          body: `${String(ctx['venueName'])} — ${String(ctx['date'])} at ${String(ctx['time'])}`,
          data: { bookingId: String(ctx['bookingId']), screen: 'BookingDetail' },
          sendSms: true,
        }
      case 'BOOKING_CANCELLED':
        return {
          title: '❌ Booking Cancelled',
          body: `Booking at ${String(ctx['venueName'])} cancelled.${ctx['refundAmount'] ? ` Refund NPR ${Number(ctx['refundAmount']) / 100} initiated.` : ''}`,
          data: { bookingId: String(ctx['bookingId']), screen: 'BookingDetail' },
          sendSms: true,
        }
      case 'SLOT_EXPIRING':
        return {
          title: '⏰ Hold Expired',
          body: 'Your slot hold expired. Please re-book.',
          data: { bookingId: String(ctx['bookingId']), screen: 'VenueDetail' },
          sendSms: false,
        }
      case 'MATCH_INVITE':
        return {
          title: `⚽ ${String(ctx['inviterName'])} invited you`,
          body: `${String(ctx['venueName'])} — ${String(ctx['date'])}. Tap to join!`,
          data: { matchGroupId: String(ctx['matchGroupId']), screen: 'MatchDetail' },
          sendSms: false,
        }
      case 'FRIEND_REQUEST':
        return {
          title: '🤝 Friend Request',
          body: `${String(ctx['requesterName'])} wants to connect.`,
          data: { userId: String(ctx['requesterId']), screen: 'FriendRequests' },
          sendSms: false,
        }
      case 'NO_SHOW_MARKED':
        return {
          title: '⚠️ No-show Recorded',
          body: `Reliability score dropped to ${String(ctx['score'])}/100. Dispute within 24h.`,
          data: { bookingId: String(ctx['bookingId']), screen: 'Reliability' },
          sendSms: true,
        }
      case 'REVIEW_REQUEST':
        return {
          title: '⭐ Rate your match',
          body: `How was ${String(ctx['venueName'])}?`,
          data: { bookingId: String(ctx['bookingId']), screen: 'WriteReview' },
          sendSms: false,
        }
      default:
        return {
          title: String(ctx['title'] ?? 'Futsmandu'),
          body:  String(ctx['body'] ?? ''),
          sendSms: false,
        }
    }
  }
}

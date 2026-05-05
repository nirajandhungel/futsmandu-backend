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
          body: `Booking at ${String(ctx['venueName'])} cancelled.${ctx['refundAmount'] ? ` Refund NPR ${Number(ctx['refundAmount'])} initiated.` : ''}`,
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
      case 'MATCH_JOIN_REQUEST':
        return {
          title: '⚽ New join request',
          body: `${String(ctx['playerName'] ?? 'A player')} requested to join your match.`,
          data: { matchGroupId: String(ctx['matchGroupId']), requestId: String(ctx['requestId']), screen: 'MatchRequests' },
          sendSms: false,
        }
      case 'MATCH_JOIN_ACCEPTED':
        return {
          title: '✅ Join request accepted',
          body: 'You are in! See match details and teammates.',
          data: { matchGroupId: String(ctx['matchGroupId']), screen: 'MatchDetail' },
          sendSms: false,
        }
      case 'MATCH_JOIN_REJECTED':
        return {
          title: '❌ Join request declined',
          body: 'Your request was not accepted this time.',
          data: { matchGroupId: String(ctx['matchGroupId']), screen: 'Matches' },
          sendSms: false,
        }
      case 'FRIEND_ADDED_TO_MATCH':
        return {
          title: '🤝 Added to a match',
          body: `${String(ctx['adminName'])} added you to a match at ${String(ctx['venueName'])}.`,
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

// apps/owner-api/src/modules/notifications/notifications.service.ts
// Owner notification service — FCM push to owner's Flutter device.
// Owner FCM tokens are stored in the owners table (fcm_token column via migration).
// Notification types specific to owners: new booking, booking cancelled, booking alert.
import { Injectable, Logger } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { PrismaService } from '@futsmandu/database'

export type OwnerNotificationType =
  | 'NEW_BOOKING'
  | 'BOOKING_CANCELLED'
  | 'PAYMENT_RECEIVED'
  | 'NEW_REVIEW'
  | 'VERIFICATION_APPROVED'
  | 'VERIFICATION_REJECTED'

interface OwnerNotifPayload {
  title: string
  body: string
  data?: Record<string, string>
  sendSms: boolean
}

function buildOwnerNotification(
  type: OwnerNotificationType,
  ctx: Record<string, unknown>,
): OwnerNotifPayload {
  switch (type) {
    case 'NEW_BOOKING':
      return {
        title: '📅 New Booking!',
        body: `${String(ctx['playerName'])} booked ${String(ctx['courtName'])} on ${String(ctx['date'])} at ${String(ctx['time'])}`,
        data: { bookingId: String(ctx['bookingId']), screen: 'BookingDetail' },
        sendSms: true,
      }
    case 'BOOKING_CANCELLED':
      return {
        title: '❌ Booking Cancelled',
        body: `Booking at ${String(ctx['courtName'])} on ${String(ctx['date'])} was cancelled.`,
        data: { bookingId: String(ctx['bookingId']), screen: 'BookingDetail' },
        sendSms: false,
      }
    case 'PAYMENT_RECEIVED':
      return {
        title: '💰 Payment Received',
        body: `NPR ${Number(ctx['amountNPR'] ?? ctx['amountPaisa'] ?? 0)} received for ${String(ctx['courtName'])}`,
        data: { bookingId: String(ctx['bookingId']), screen: 'Analytics' },
        sendSms: false,
      }
    case 'NEW_REVIEW':
      return {
        title: '⭐ New Review',
        body: `${String(ctx['playerName'])} left a ${String(ctx['rating'])}-star review for ${String(ctx['venueName'])}`,
        data: { venueId: String(ctx['venueId']), screen: 'Reviews' },
        sendSms: false,
      }
    case 'VERIFICATION_APPROVED':
      return {
        title: '✅ Venue Verified!',
        body: `${String(ctx['venueName'])} has been verified and is now live on Futsmandu.`,
        data: { venueId: String(ctx['venueId']), screen: 'VenueDetail' },
        sendSms: true,
      }
    case 'VERIFICATION_REJECTED':
      return {
        title: '❗ Verification Issue',
        body: `Please check the verification requirements for ${String(ctx['venueName'])}.`,
        data: { venueId: String(ctx['venueId']), screen: 'VerificationDocs' },
        sendSms: true,
      }
    default:
      return { title: 'Futsmandu', body: String(ctx['body'] ?? ''), sendSms: false }
  }
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name)

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('notifications') private readonly notifQueue: Queue,
    @InjectQueue('sms') private readonly smsQueue: Queue,
  ) {}

  async notifyOwner(
    ownerId: string,
    type: OwnerNotificationType,
    ctx: Record<string, unknown>,
  ): Promise<void> {
    await this.notifQueue
      .add(
        'owner-notification',
        { ownerId, type, data: ctx },
        { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 100, removeOnFail: 200 },
      )
      .catch((e: unknown) => this.logger.error('Failed to enqueue owner notification', e))
  }

  async getOwnerNotifications(ownerId: string, page = 1) {
    const PAGE_SIZE = 20
    const skip = (page - 1) * PAGE_SIZE
    // Owner notifications stored in a separate table conceptually
    // For now queried from owners table context — extend schema as needed
    return {
      data: [],
      meta: { page, total: 0, note: 'Extend with owner_notifications table in migration 004' },
    }
  }
}

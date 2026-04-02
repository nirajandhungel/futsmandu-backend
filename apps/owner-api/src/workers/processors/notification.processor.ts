// apps/owner-api/src/workers/processors/notification.processor.ts
// Owner notification processor — sends FCM push to owner's Flutter device.
// Owner FCM tokens stored in owners.fcm_token (add via migration 004_owner_fcm_token.sql).
// Also sends SMS for high-priority owner alerts (new booking, payment received).

import { Processor, InjectQueue, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Job, Queue } from 'bullmq'
import { PrismaService, Prisma } from '@futsmandu/database'
import admin from 'firebase-admin'
import { ENV } from '@futsmandu/utils'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

interface OwnerNotifPayload {
  title: string
  body: string
  data?: Record<string, string>
  sendSms: boolean
}

function buildOwnerNotification(type: string, ctx: Record<string, unknown>): OwnerNotifPayload {
  switch (type) {
    case 'NEW_BOOKING':
      return {
        title: '📅 New Booking!',
        body: `${String(ctx['playerName'])} booked ${String(ctx['courtName'])} — ${String(ctx['date'])} ${String(ctx['time'])}`,
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
        body: `NPR ${Number(ctx['amountPaisa']) / 100} for ${String(ctx['courtName'])}`,
        data: { bookingId: String(ctx['bookingId']), screen: 'Analytics' },
        sendSms: false,
      }
    case 'NEW_REVIEW':
      return {
        title: '⭐ New Review',
        body: `${String(ctx['rating'])}-star review for ${String(ctx['venueName'])}`,
        data: { venueId: String(ctx['venueId']), screen: 'Reviews' },
        sendSms: false,
      }
    case 'VERIFICATION_APPROVED':
      return {
        title: '✅ Venue Verified!',
        body: `${String(ctx['venueName'])} is now live on Futsmandu.`,
        data: { venueId: String(ctx['venueId']), screen: 'VenueDetail' },
        sendSms: true,
      }
    case 'VERIFICATION_REJECTED':
      return {
        title: '❗ Verification Issue',
        body: `Action needed for ${String(ctx['venueName'])}. Check documents.`,
        data: { venueId: String(ctx['venueId']), screen: 'VerificationDocs' },
        sendSms: true,
      }
    default:
      return {
        title: String(ctx['title'] ?? 'Futsmandu'),
        body: String(ctx['body'] ?? ''),
        sendSms: false,
      }
  }
}

// Firebase init — same guard pattern as player-api
let fcm: admin.messaging.Messaging | null = null

function resolveFirebaseServiceAccount(raw: string): admin.ServiceAccount | null {
  if (raw.startsWith('{')) {
    return JSON.parse(raw) as admin.ServiceAccount
  }

  const rootDir = path.resolve(process.cwd(), '../../')
  const candidates = [
    raw,
    path.resolve(process.cwd(), raw),
    path.resolve(rootDir, raw),
    path.resolve(rootDir, path.basename(raw)),
    path.resolve(rootDir, 'futsmandu-firebase-adminsdk.json'),
  ]

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue
    const text = readFileSync(filePath, 'utf-8')
    return JSON.parse(text) as admin.ServiceAccount
  }

  return null
}

if (!admin.apps.length) {
  const raw = ENV['FIREBASE_SERVICE_ACCOUNT']
  if (!raw) {
    new Logger('OwnerNotificationProcessor').warn(
      'FIREBASE_SERVICE_ACCOUNT not set — owner FCM push notifications disabled.',
    )
  } else {
    try {
      const certData = resolveFirebaseServiceAccount(raw)
      if (!certData) {
        new Logger('OwnerNotificationProcessor').warn(
          'FIREBASE_SERVICE_ACCOUNT path not found. Checked worker cwd and repo root; owner FCM disabled.',
        )
      } else {
        admin.initializeApp({ credential: admin.credential.cert(certData) })
        fcm = admin.messaging()
      }
    } catch (err) {
      new Logger('OwnerNotificationProcessor').error('FIREBASE_SERVICE_ACCOUNT invalid or missing — FCM disabled', err)
    }
  }
} else {
  fcm = admin.messaging()
}

interface OwnerNotifJobData {
  ownerId: string
  type: string
  data: Record<string, unknown>
}

interface SmsJobData {
  phone: string
  message: string
}

@Processor('notifications')
export class OwnerNotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(OwnerNotificationProcessor.name)

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('sms') private readonly smsQueue: Queue,
  ) {
    super()
  }

  async process(job: Job<OwnerNotifJobData>): Promise<void> {
    if (job.name !== 'owner-notification') return
    const { ownerId, type, data } = job.data
    const payload = buildOwnerNotification(type, data)

    // Fetch owner's FCM token and phone
    // NOTE: owners table needs fcm_token + phone columns.
    // fcm_token added via migration 004_owner_fcm_token.sql
    const owner = await this.prisma.owners.findUnique({
      where: { id: ownerId },
      select: { phone: true, verification_docs: true },
    })

    // FCM push to owner device
    // The fcm_token is stored in verification_docs temporarily until migration 004 adds the column
    const docs = (owner?.verification_docs as Record<string, unknown>) ?? {}
    const fcmToken = docs['fcm_token'] as string | undefined

    if (fcm && fcmToken) {
      await fcm.send({
        token: fcmToken,
        notification: { title: payload.title, body: payload.body },
        data: payload.data ?? {},
        android: { priority: 'high' },
        apns: { payload: { aps: { contentAvailable: true } } },
      }).catch(async (err: unknown) => {
        if (String(err).includes('registration-token-not-registered')) {
          // Clear stale FCM token
          const meta = (owner?.verification_docs as Record<string, unknown>) ?? {}
          delete meta['fcm_token']
          await this.prisma.owners.update({
            where: { id: ownerId },
            data: { verification_docs: meta as Prisma.InputJsonValue },
          })
        }
        this.logger.warn(`Owner FCM failed for ${ownerId}: ${String(err)}`)
      })
    } else {
      this.logger.debug(`No FCM token for owner ${ownerId} — skipping push`)
    }

    // SMS for high-priority owner alerts
    if (payload.sendSms && owner?.phone) {
      await this.smsQueue
        .add(
          'send-sms',
          { phone: owner.phone, message: `Futsmandu: ${payload.body}` } satisfies SmsJobData,
          { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 50, removeOnFail: 100 },
        )
        .catch((e: unknown) => this.logger.error('Failed to enqueue owner SMS', e))
    }

    this.logger.log(`Owner notification sent: ${type} → ${ownerId}`)
  }
}

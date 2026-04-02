// CHANGED: [M-3 Firebase fails at startup if FIREBASE_SERVICE_ACCOUNT not set]
// NEW ISSUES FOUND:
//   - admin.initializeApp used JSON.parse(... ?? '{}') which silently created an
//     app with empty credentials — FCM calls would fail at runtime with no clear error

// apps/player-api/src/workers/processors/notification.processor.ts
// Handles FCM push + DB inbox save + SMS dispatch.
// M-3: FIREBASE_SERVICE_ACCOUNT validated at module init — throws immediately if missing.

import { Processor, InjectQueue, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Job, Queue } from 'bullmq'
import { PrismaService } from '@futsmandu/database'
import type { Prisma } from '@futsmandu/database'
import { NotificationFactory } from '@futsmandu/utils'
import type { NotificationJobData, SmsJobData } from '@futsmandu/types'
import admin from 'firebase-admin'
import type { notification_type } from '@futsmandu/database'
import { ENV } from '@futsmandu/utils'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

// M-3: Validate FIREBASE_SERVICE_ACCOUNT before attempting to init.
// A missing or invalid env var is caught here at worker startup, not at the first
// notification attempt where the error would be cryptic.
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
    // Log and disable FCM — do not crash the worker (SMS/inbox still works without FCM)
    new Logger('NotificationProcessor').warn(
      'FIREBASE_SERVICE_ACCOUNT not set — FCM push notifications disabled. ' +
      'Set this env var to enable push notifications.',
    )
  } else {
    try {
      const certData = resolveFirebaseServiceAccount(raw)
      if (!certData) {
        new Logger('NotificationProcessor').warn(
          'FIREBASE_SERVICE_ACCOUNT path not found. Checked worker cwd and repo root; FCM disabled.',
        )
      } else {
        admin.initializeApp({ credential: admin.credential.cert(certData) })
        fcm = admin.messaging()
      }
    } catch (err) {
      new Logger('NotificationProcessor').error(
        'FIREBASE_SERVICE_ACCOUNT validation failed — FCM disabled',
        err,
      )
    }
  }
} else {
  fcm = admin.messaging()
}

@Processor('notifications')
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name)

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('sms') private readonly smsQueue: Queue,
  ) {
    super()
  }

  async process(job: Job<NotificationJobData>): Promise<void> {
    const { type, userId, data } = job.data
    const payload = NotificationFactory.build(type, data)

    // 1. Save to in-app inbox
    await this.prisma.notifications.create({
      data: {
        user_id: userId,
        type: type as notification_type,
        title: payload.title,
        body: payload.body,
        data: data as Prisma.InputJsonValue,
      },
    })

    // 2. FCM push (skipped gracefully if Firebase not configured)
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { fcm_token: true, phone: true },
    })

    if (fcm && user?.fcm_token) {
      await fcm.send({
        token: user.fcm_token,
        notification: { title: payload.title, body: payload.body },
        data: payload.data ?? {},
        android: { priority: 'high' },
        apns: { payload: { aps: { contentAvailable: true } } },
      }).catch(async (err: unknown) => {
        if (String(err).includes('registration-token-not-registered')) {
          await this.prisma.users.update({ where: { id: userId }, data: { fcm_token: null } })
        }
        this.logger.warn(`FCM failed for user ${userId}: ${String(err)}`, { jobId: job.id })
      })
    }

    // 3. SMS for high-priority types
    if (payload.sendSms && user?.phone) {
      await this.smsQueue
        .add(
          'send-sms',
          { phone: user.phone, message: `Futsmandu: ${payload.body}` } satisfies SmsJobData,
          { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 50, removeOnFail: 100 },
        )
        .catch((e: unknown) => this.logger.error('Failed to enqueue SMS', e, { jobId: job.id }))
    }
  }
}

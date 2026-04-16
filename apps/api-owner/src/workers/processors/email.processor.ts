// apps/owner-api/src/workers/processors/email.processor.ts

import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Job } from 'bullmq'
import { captureException } from '@futsmandu/sentry'
import { ENV } from '@futsmandu/utils'
import { Resend } from 'resend'

// ── Cache env (performance improvement)
const resendKey = ENV['RESEND_API_KEY']
const appUrl = ENV['APP_URL'] ?? 'https://nirajandhungel.com.np'
const resend = resendKey ? new Resend(resendKey) : null

interface OwnerEmailJobData {
  type:
    | 'owner-welcome'
    | 'booking-alert'
    | 'verification-approved'
    | 'verification-rejected'
    | 'password-reset'
    | 'otp-verification'
  to: string
  name?: string
  data?: Record<string, unknown>
}

const SUBJECTS: Record<string, string> = {
  'owner-welcome': 'Welcome to Futsmandu for Venue Owners! 🏟️',
  'booking-alert': 'New booking received — Futsmandu',
  'verification-approved': '✅ Your venue is now verified on Futsmandu',
  'verification-rejected': '❗ Action required: Venue verification',
  'password-reset': 'Reset your Futsmandu owner password',
  'otp-verification': 'Your Futsmandu verification code',
}

@Processor('owner-emails')
export class OwnerEmailProcessor extends WorkerHost {
  private readonly logger = new Logger(OwnerEmailProcessor.name)

  async process(job: Job<OwnerEmailJobData>): Promise<void> {
    const { type, to, name, data } = job.data

    if (!to) {
      this.logger.warn(`Email job ${type} skipped — missing recipient`, {
        jobId: job.id,
      })
      return
    }

    if (!resend) {
      this.logger.error('RESEND_API_KEY not set — email skipped', {
        type,
        to,
        jobId: job.id,
      })
      return
    }

    const subject = SUBJECTS[type] ?? `Futsmandu — ${type}`
    const html = this.buildHtml(type, name, data)

    const { error } = await resend.emails.send({
      from: 'Futsmandu Owners <owners@mail.nirajandhungel.com.np>',
      to,
      subject,
      html,
    })

    // ❌ DO NOT throw (prevents retry loop)
    if (error) {
      this.logger.error(
        `Resend failed for ${type} → ${to}: ${JSON.stringify(error)}`,
        { jobId: job.id },
      )

      captureException(error, {
        jobId: job.id,
        processor: 'OwnerEmailProcessor',
      })

      return
    }

    this.logger.log(`[Email] ${type} → ${to}`, { jobId: job.id })
  }

  // ── HTML builder ────────────────────────────────────────────────

  private buildHtml(
    type: string,
    name: string | undefined,
    data: Record<string, unknown> | undefined,
  ): string {
    const hi = `<p>Hi ${name ?? 'there'},</p>`

    switch (type) {
      case 'otp-verification': {
        const otp = String(data?.['otp'] ?? '')

        return `
          ${hi}
          <p>Use the code below to verify your email address.</p>

          <div style="
            display:inline-block;
            padding:16px 32px;
            background:#f4f4f4;
            border-radius:8px;
            font-size:32px;
            font-weight:bold;
            letter-spacing:8px;
            color:#222;
            margin:16px 0;
          ">${otp}</div>

          <p>This code expires in <strong>10 minutes</strong>.</p>

          <p style="color:#888;font-size:12px;">
            Never share this code with anyone.
          </p>
        `
      }

      case 'owner-welcome':
        return `
          ${hi}
          <p>Welcome to Futsmandu! Your owner account is ready.</p>
          <p><a href="${appUrl}/owner">Open Owner App →</a></p>
        `

      case 'booking-alert':
        return `
          ${hi}
          <p>You have a new booking:</p>
          <ul>
            <li>Court: ${String(data?.['courtName'] ?? '')}</li>
            <li>Date: ${String(data?.['date'] ?? '')}</li>
            <li>Time: ${String(data?.['startTime'] ?? '')}</li>
            <li>Player: ${String(data?.['playerName'] ?? '')}</li>
          </ul>
        `

      case 'verification-approved':
        return `
          ${hi}
          <p>
            Your venue <strong>${String(data?.['venueName'] ?? '')}</strong>
            is now verified and live.
          </p>
        `

      case 'verification-rejected':
        return `
          ${hi}
          <p>
            Verification failed for <strong>${String(data?.['venueName'] ?? '')}</strong>.
          </p>
          <p>Reason: ${String(data?.['reason'] ?? 'Not specified')}</p>
        `

      default:
        return `${hi}<p>${JSON.stringify(data ?? {})}</p>`
    }
  }
}
// apps/player-api/src/workers/processors/email.processor.ts

import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Job } from 'bullmq'
import type { EmailJobData } from '@futsmandu/types'
import { ENV } from '@futsmandu/utils'
import { Resend } from 'resend'

// ── Extend job types ───────────────────────────────────────────────

type PlayerEmailJobData =
  | EmailJobData
  | {
      type: 'otp-verification'
      to: string
      name?: string
      data: { otp: string; userType: 'player' | 'owner' | 'admin' }
    }

// ── Subject map ─────────────────────────────────────────────────────

const SUBJECTS: Record<string, string> = {
  'booking-confirmation': 'Your Futsmandu booking is confirmed ✅',
  'verification-email': 'Verify your Futsmandu email',
  'password-reset': 'Reset your Futsmandu password',
  'otp-verification': 'Your Futsmandu verification code',
  FRIEND_ADDED_TO_MATCH: 'You were added to a match ⚽',
}

// ── Resend singleton (IMPORTANT OPTIMIZATION) ──────────────────────

const resendKey = ENV['RESEND_API_KEY']
const resend = resendKey ? new Resend(resendKey) : null

@Processor('player-emails')
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name)

  async process(job: Job<PlayerEmailJobData>): Promise<void> {
    const { type, to, name, data } = job.data

    // ── validation ────────────────────────────────────────────────
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
    const html = this.buildHtml(type, name, data as Record<string, unknown>)

    // ── send email ────────────────────────────────────────────────
    const { error } = await resend.emails.send({
      from: 'Futsmandu <noreply@mail.nirajandhungel.com.np>',
      to,
      subject,
      html,
    })

    // ❌ IMPORTANT: do NOT throw (prevents retry storm)
    if (error) {
      this.logger.error(
        `Resend failed for ${type} → ${to}: ${JSON.stringify(error)}`,
        {
          jobId: job.id,
        },
      )
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

      case 'FRIEND_ADDED_TO_MATCH': {
        return `
          ${hi}
          <p>
            You've been added to ${String(data?.['adminName'] ?? 'a friend')}'s match
            at ${String(data?.['venueName'] ?? 'a venue')}
            on ${String(data?.['date'] ?? '')}
            at ${String(data?.['startTime'] ?? '')}.
          </p>

          <p>
            <a href="${String(data?.['matchGroupId'] ?? '')}">
              Open match details
            </a>
          </p>
        `
      }

      default:
        return `${hi}<p>${JSON.stringify(data ?? {})}</p>`
    }
  }
}
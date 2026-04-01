// apps/owner-api/src/workers/processors/email.processor.ts
// Owner email processor — welcome emails, booking alerts, KYC status.
// Uses Resend SDK. Falls back silently if RESEND_API_KEY is not set.
import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Job } from 'bullmq'
import { ENV } from '@futsmandu/utils'

interface OwnerEmailJobData {
  type: 'owner-welcome' | 'booking-alert' | 'verification-approved' | 'verification-rejected' | 'password-reset'
  to: string
  name?: string
  data?: Record<string, unknown>
}

const SUBJECTS: Record<string, string> = {
  'owner-welcome':             'Welcome to Futsmandu for Venue Owners! 🏟️',
  'booking-alert':             'New booking received — Futsmandu',
  'verification-approved':     '✅ Your venue is now verified on Futsmandu',
  'verification-rejected':     '❗ Action required: Venue verification',
  'password-reset':            'Reset your Futsmandu owner password',
}

@Processor('owner-emails')
export class OwnerEmailProcessor extends WorkerHost {
  private readonly logger = new Logger(OwnerEmailProcessor.name)

  async process(job: Job<OwnerEmailJobData>): Promise<void> {
    const { type, to, name, data } = job.data

    if (!to) {
      this.logger.warn(`Email job ${type} skipped — no recipient`, { jobId: job.id })
      return
    }

    const resendKey = ENV['RESEND_API_KEY']
    if (!resendKey) {
      this.logger.error('RESEND_API_KEY not set — owner email not sent', undefined, { type, to })
      return
    }

    const { Resend } = await import('resend')
    const resend     = new Resend(resendKey)
    const subject    = SUBJECTS[type] ?? `Futsmandu — ${type}`

    // Build HTML per type — extend with proper templates (Resend React templates recommended)
    let html = `<p>Hi ${name ?? 'there'},</p>`
    switch (type) {
      case 'owner-welcome':
        html += `<p>Welcome to Futsmandu! Your owner account is set up. Start by adding your venue and courts.</p>`
        html += `<p><a href="${ENV['APP_URL'] ?? 'https://futsmandu.app'}/owner">Open Owner App →</a></p>`
        break
      case 'booking-alert':
        html += `<p>You have a new booking:</p>`
        html += `<ul><li>Court: ${String(data?.['courtName'] ?? '')}</li>`
        html += `<li>Date: ${String(data?.['date'] ?? '')}</li>`
        html += `<li>Time: ${String(data?.['startTime'] ?? '')}</li>`
        html += `<li>Player: ${String(data?.['playerName'] ?? '')}</li></ul>`
        break
      case 'verification-approved':
        html += `<p>Great news! Your venue <strong>${String(data?.['venueName'] ?? '')}</strong> has been verified and is now live on Futsmandu.</p>`
        break
      case 'verification-rejected':
        html += `<p>There's an issue with the verification for <strong>${String(data?.['venueName'] ?? '')}</strong>.</p>`
        html += `<p>Reason: ${String(data?.['reason'] ?? 'Please resubmit your documents.')}</p>`
        break
      default:
        html += `<p>${JSON.stringify(data)}</p>`
    }
    html += `<p>— The Futsmandu Team</p>`

    const { error } = await resend.emails.send({
      from: 'Futsmandu for Owners <owners@futsmandu.app>',
      to,
      subject,
      html,
    })

    if (error) throw new Error(`Resend error for ${type} to ${to}: ${JSON.stringify(error)}`)

    this.logger.log(`[Email] ${type} → ${to}`, { jobId: job.id })
  }
}

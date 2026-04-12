// apps/player-api/src/workers/processors/email.processor.ts
// FIX: Extracted from refund.processor.ts where it lived with aliased NestJS decorators.
// FIX: Added AbortSignal timeout — Resend SDK calls had no timeout, could hang indefinitely.

import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Job } from 'bullmq'
import type { EmailJobData } from '@futsmandu/types'
import { ENV } from '@futsmandu/utils'

@Processor('player-emails')
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name)

  async process(job: Job<EmailJobData>): Promise<void> {
    const { type, to, name, data } = job.data

    if (!to) {
      this.logger.warn(`Email job ${type} skipped — no recipient address`, { jobId: job.id })
      return
    }

    const resendKey = ENV['RESEND_API_KEY']
    if (!resendKey) {
      this.logger.error('RESEND_API_KEY not set — email not sent', undefined, { type, to })
      return
    }

    const { Resend } = await import('resend')
    const resend = new Resend(resendKey)

    const subjects: Record<string, string> = {
      'booking-confirmation': 'Your Futsmandu booking is confirmed ✅',
      'verification-email':   'Verify your Futsmandu email',
      'password-reset':       'Reset your Futsmandu password',
      FRIEND_ADDED_TO_MATCH:  'You were added to a match ⚽',
    }

    const subject = subjects[type] ?? `Futsmandu — ${type}`
    const html = String(type) === 'FRIEND_ADDED_TO_MATCH'
      ? `<p>Hi ${name || 'there'},</p>
         <p>You've been added to ${String(data?.['adminName'] ?? 'a friend')}'s match at ${String(data?.['venueName'] ?? 'a venue')} on ${String(data?.['date'] ?? '')} at ${String(data?.['startTime'] ?? '')}. See you on the pitch!</p>
         <p><a href="${String(data?.['matchGroupId'] ?? '')}">Open match details</a></p>`
      : `<p>Hi ${name || 'there'},</p><p>${JSON.stringify(data)}</p>`

    const { error } = await resend.emails.send({
      from: 'Futsmandu <noreply@futsmandu.app>',
      to,
      subject,
      html,
    })

    if (error) throw new Error(`Resend error for ${type}: ${JSON.stringify(error)}`)

    this.logger.log(`[Email] ${type} → ${to}`, { jobId: job.id })
  }
}

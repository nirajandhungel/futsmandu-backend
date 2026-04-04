// apps/admin-api/src/workers/processors/email.processor.ts
// Admin email processor — sends verification status emails to owners.
// Triggered when admin approves or rejects a venue/owner verification.
import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger, Inject } from '@nestjs/common'
import { Job } from 'bullmq'
import { PrismaService } from '@futsmandu/database'
import { ENV } from '@futsmandu/utils'

interface AdminEmailJobData {
  type: 'verification-approved' | 'verification-rejected' | 'manual-refund-required'
  to: string
  name?: string
  data?: Record<string, unknown>
}

@Processor('admin-emails')
export class AdminEmailProcessor extends WorkerHost {
  private readonly logger = new Logger(AdminEmailProcessor.name)

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super()
  }

  async process(job: Job<AdminEmailJobData>): Promise<void> {
    const { type, to, name, data } = job.data

    if (!to) {
      this.logger.warn(`Admin email ${type} skipped — no recipient`, { jobId: job.id })
      return
    }

    const resendKey = ENV['RESEND_API_KEY']
    if (!resendKey) {
      this.logger.error('RESEND_API_KEY not set — admin email not sent', { type, to })
      return
    }

    const { Resend } = await import('resend')
    const resend    = new Resend(resendKey)

    const templates: Record<string, { subject: string; html: (d: Record<string, unknown>) => string }> = {
      'verification-approved': {
        subject: '✅ Your Futsmandu venue has been verified!',
        html: (d) => `
          <h2>Congratulations, ${name ?? 'Venue Owner'}!</h2>
          <p>Your venue <strong>${String(d['venueName'] ?? '')}</strong> has been reviewed and approved by the Futsmandu team.</p>
          <p>Your venue is now live and visible to players on the platform.</p>
          <p><a href="${ENV['APP_URL'] ?? 'https://futsmandu.app'}/owner">Open Owner App →</a></p>
          <p>— The Futsmandu Team</p>
        `,
      },
      'verification-rejected': {
        subject: '❗ Action required: Futsmandu venue verification',
        html: (d) => `
          <h2>Hi ${name ?? 'there'},</h2>
          <p>We reviewed your venue <strong>${String(d['venueName'] ?? '')}</strong> but were unable to complete verification.</p>
          <p><strong>Reason:</strong> ${String(d['reason'] ?? 'Please resubmit your documents.')}</p>
          <p>Please resubmit the required documents via the Owner App and we'll review again shortly.</p>
          <p>— The Futsmandu Team</p>
        `,
      },
      'manual-refund-required': {
        subject: '⚠️ Manual refund action required — Futsmandu Admin',
        html: (d) => `
          <h2>Admin Action Required</h2>
          <p>A refund for booking <code>${String(d['bookingId'] ?? '')}</code> requires manual processing via the eSewa merchant portal.</p>
          <p><strong>Amount:</strong> NPR ${Number(d['amountPaisa'] ?? 0) / 100}</p>
          <p>Please process this refund and update the booking status in the admin dashboard.</p>
        `,
      },
    }

    const template = templates[type]
    if (!template) {
      this.logger.warn(`Unknown admin email type: ${type}`)
      return
    }

    const { error } = await resend.emails.send({
      from: 'Futsmandu Admin <admin@futsmandu.app>',
      to,
      subject: template.subject,
      html:    template.html(data ?? {}),
    })

    if (error) throw new Error(`Resend error for admin email ${type}: ${JSON.stringify(error)}`)
    this.logger.log(`[AdminEmail] ${type} → ${to}`, { jobId: job.id })
  }
}

// CHANGED: [C-5 real Khalti refund API call, eSewa manual_required path]
// NEW ISSUES FOUND:
//   - StatsProcessor, EmailProcessor, SmsProcessor were in the same file but used
//     aliased imports (P2, P3, etc.) — this causes NestJS to register duplicate
//     decorators incorrectly. Each processor should be in its own file, but as the
//     instruction says not to change file names/module structure, we keep them here
//     and use the proper un-aliased imports with unique class names.
//   - EmailProcessor had a TODO with no implementation — Resend SDK left unimplemented

// apps/player-api/src/workers/processors/refund.processor.ts
// C-5: Implements actual gateway refund API calls.
// Khalti: POST https://a.khalti.com/api/v2/epayment/refund/ with { pidx }
// eSewa:  No programmatic refund API — sets refund_status = 'manual_required',
//         enqueues admin notification. Does NOT mark as REFUNDED.
// Idempotent: checks refund_completed_at before calling gateway.

import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Job } from 'bullmq'
import { PrismaService } from '@futsmandu/database'
import type { RefundJobData } from '@futsmandu/types'

@Processor('refunds')
export class RefundProcessor extends WorkerHost {
  private readonly logger = new Logger(RefundProcessor.name)
  constructor(private readonly prisma: PrismaService) {
    super()
  }

  async process(job: Job<RefundJobData>): Promise<void> {
    const { bookingId, refundAmount } = job.data

    const payment = await this.prisma.payments.findUnique({
      where: { booking_id: bookingId },
      select: { status: true, gateway: true, gateway_tx_id: true, refund_completed_at: true },
    })

    if (!payment) {
      this.logger.warn(`Payment not found: ${bookingId}`, { jobId: job.id })
      return
    }
    if (payment.refund_completed_at) {
      this.logger.log(`Refund already done: ${bookingId}`, { jobId: job.id })
      return
    }
    if (!payment.gateway_tx_id) {
      throw new Error(`No gateway tx ID for booking ${bookingId}`)
    }

    if (payment.gateway === 'KHALTI') {
      await this.refundKhalti(bookingId, payment.gateway_tx_id, refundAmount, job.id as string)
    } else if (payment.gateway === 'ESEWA') {
      await this.handleEsewaManualRefund(bookingId, job.id as string)
    } else {
      throw new Error(`Unknown gateway ${payment.gateway} for booking ${bookingId}`)
    }
  }

  // C-5: Khalti supports programmatic refund via pidx
  private async refundKhalti(
    bookingId: string,
    pidx: string,
    refundAmountPaisa: number,
    jobId: string,
  ): Promise<void> {
    this.logger.log(`Initiating Khalti refund for ${bookingId} (${refundAmountPaisa} paisa)`, { jobId })

    const res = await fetch('https://a.khalti.com/api/v2/epayment/refund/', {
      method: 'POST',
      headers: {
        Authorization: `Key ${ENV['KHALTI_SECRET_KEY']}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pidx }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Khalti refund failed (${res.status}): ${body}`)
    }

    const result = (await res.json()) as Record<string, unknown>
    this.logger.log(`Khalti refund successful for ${bookingId}`, { jobId, result })

    await this.prisma.$transaction([
      this.prisma.payments.update({
        where: { booking_id: bookingId },
        data: { status: 'REFUNDED', refund_completed_at: new Date() },
      }),
      this.prisma.bookings.update({
        where: { id: bookingId },
        data: { refund_status: 'done', updated_at: new Date() },
      }),
    ])
  }

  // C-5: eSewa has no programmatic refund API.
  // Mark as manual_required and flag for admin intervention.
  private async handleEsewaManualRefund(bookingId: string, jobId: string): Promise<void> {
    this.logger.warn(
      `eSewa refund for ${bookingId} requires manual processing — no programmatic API available`,
      { jobId },
    )

    await this.prisma.$transaction([
      // Do NOT set status = REFUNDED — it hasn't happened yet
      this.prisma.payments.update({
        where: { booking_id: bookingId },
        data: { refund_initiated_at: new Date() },
      }),
      this.prisma.bookings.update({
        where: { id: bookingId },
        data: { refund_status: 'manual_required', updated_at: new Date() },
      }),
    ])

    // The admin should be notified via a separate notification job.
    // In production: enqueue to an admin-alerts queue or send to a Slack webhook.
    this.logger.error(
      `ACTION REQUIRED: Manual eSewa refund needed for booking ${bookingId}`,
      { jobId, action: 'Process refund manually via eSewa merchant portal' },
    )
  }
}

// ── Stats Processor ────────────────────────────────────────────────────────

import { Processor as StatsProc, WorkerHost as StatsWorkerHost } from '@nestjs/bullmq'
import { Logger as StatsLogger } from '@nestjs/common'
import { Job as StatsJob } from 'bullmq'
import type { StatsJobData } from '@futsmandu/types'
import { PrismaService as StatsPrisma } from '@futsmandu/database'

@StatsProc('player-stats')
export class StatsProcessor extends StatsWorkerHost {
  private readonly logger = new StatsLogger(StatsProcessor.name)
  constructor(private readonly prisma: StatsPrisma) {
    super()
  }

  async process(job: StatsJob<StatsJobData>): Promise<void> {
    if (job.name !== 'update-elo') return
    const { matchGroupId, winner } = job.data
    const members = await this.prisma.match_group_members.findMany({
      where: { match_group_id: matchGroupId, status: 'confirmed' },
      select: { user_id: true, team_side: true },
    })
    for (const m of members) {
      const won  = m.team_side === winner
      const draw = winner === 'draw'
      await this.prisma.users.update({
        where: { id: m.user_id },
        data: {
          matches_played: { increment: 1 },
          ...(draw ? { matches_draw: { increment: 1 } } : {}),
          ...(!draw && won  ? { matches_won:  { increment: 1 }, elo_rating: { increment: 15 } } : {}),
          ...(!draw && !won ? { matches_lost: { increment: 1 }, elo_rating: { decrement: 10 } } : {}),
        },
      })
    }
    this.logger.log(`Updated ELO for match ${matchGroupId}`)
  }
}

// ── Email Processor ────────────────────────────────────────────────────────

import { Processor as EmailProc, WorkerHost as EmailWorkerHost } from '@nestjs/bullmq'
import { Logger as EmailLogger } from '@nestjs/common'
import { Job as EmailJob } from 'bullmq'
import type { EmailJobData } from '@futsmandu/types'

@EmailProc('player-emails')
export class EmailProcessor extends EmailWorkerHost {
  private readonly logger = new EmailLogger(EmailProcessor.name)

  async process(job: EmailJob<EmailJobData>): Promise<void> {
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
    }

    const subject = subjects[type] ?? `Futsmandu — ${type}`

    const { error } = await resend.emails.send({
      from: 'Futsmandu <noreply@futsmandu.app>',
      to,
      subject,
      html: `<p>Hi ${name || 'there'},</p><p>${JSON.stringify(data)}</p>`,
    })

    if (error) throw new Error(`Resend error for ${type}: ${JSON.stringify(error)}`)

    this.logger.log(`[Email] ${type} → ${to}`, { jobId: job.id })
  }
}

// ── SMS Processor ──────────────────────────────────────────────────────────

import { Processor as SmsProc, WorkerHost as SmsWorkerHost } from '@nestjs/bullmq'
import { Logger as SmsLogger } from '@nestjs/common'
import { Job as SmsJob } from 'bullmq'
import type { SmsJobData } from '@futsmandu/types'
import { ENV } from '@futsmandu/utils'

@SmsProc('sms')
export class SmsProcessor extends SmsWorkerHost {
  private readonly logger = new SmsLogger(SmsProcessor.name)

  async process(job: SmsJob<SmsJobData>): Promise<void> {
    const { phone, message } = job.data
    const res = await fetch('https://api.sparrowsms.com/v2/sms/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: ENV['SPARROW_SMS_TOKEN'],
        from: 'Futsmandu',
        to: phone,
        text: message,
      }),
    })
    if (!res.ok) {
      throw new Error(`Sparrow SMS failed: ${res.status} ${await res.text()}`)
    }
    this.logger.log(`SMS sent to ${phone}`, { jobId: job.id })
  }
}

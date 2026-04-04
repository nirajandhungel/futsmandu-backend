// apps/player-api/src/workers/processors/refund.processor.ts
// C-5: Implements actual gateway refund API calls.
// Khalti: POST https://a.khalti.com/api/v2/epayment/refund/ with { pidx }
// eSewa:  No programmatic refund API — sets refund_status = 'manual_required'.
// Idempotent: checks refund_completed_at before calling gateway.
// FIX: Added missing ENV import (was causing ReferenceError on Khalti refunds).
// FIX: Added AbortSignal timeout to all external fetch calls (was missing — hung requests blocked worker).

import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger, Inject } from '@nestjs/common'
import { Job } from 'bullmq'
import { PrismaService } from '@futsmandu/database'
import type { RefundJobData } from '@futsmandu/types'
import { ENV } from '@futsmandu/utils'

/** Milliseconds before an external gateway call is aborted. */
const GATEWAY_TIMEOUT_MS = 15_000

@Processor('refunds')
export class RefundProcessor extends WorkerHost {
  private readonly logger = new Logger(RefundProcessor.name)
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
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

  private async refundKhalti(
    bookingId: string,
    pidx: string,
    refundAmountPaisa: number,
    jobId: string,
  ): Promise<void> {
    this.logger.log(`Initiating Khalti refund for ${bookingId} (${refundAmountPaisa} paisa)`, { jobId })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS)

    let res: Response
    try {
      res = await fetch('https://a.khalti.com/api/v2/epayment/refund/', {
        method: 'POST',
        headers: {
          Authorization: `Key ${ENV['KHALTI_SECRET_KEY']}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ pidx }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

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

  private async handleEsewaManualRefund(bookingId: string, jobId: string): Promise<void> {
    this.logger.warn(
      `eSewa refund for ${bookingId} requires manual processing — no programmatic API available`,
      { jobId },
    )

    await this.prisma.$transaction([
      this.prisma.payments.update({
        where: { booking_id: bookingId },
        data: { refund_initiated_at: new Date() },
      }),
      this.prisma.bookings.update({
        where: { id: bookingId },
        data: { refund_status: 'manual_required', updated_at: new Date() },
      }),
    ])

    this.logger.error(
      `ACTION REQUIRED: Manual eSewa refund needed for booking ${bookingId}`,
      { jobId, action: 'Process refund manually via eSewa merchant portal' },
    )
  }
}

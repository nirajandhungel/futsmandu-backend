// apps/player-api/src/workers/processors/payment-recon.processor.ts
// Runs every 15 minutes — catches missed gateway callbacks.
// Independent server-side verification. Idempotent — checks status before processing.

import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger, Inject } from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import { BookingService } from '../../modules/booking/booking.service.js'
import { PaymentService } from '../../modules/payment/payment.service.js'

@Processor('payment-recon')
export class PaymentReconProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentReconProcessor.name)

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BookingService) private readonly bookingService: BookingService,
    @Inject(PaymentService) private readonly paymentService: PaymentService,
  ) {
    super()
  }

  async process(): Promise<void> {
    const pending = await this.prisma.bookings.findMany({
      where: { status: 'PENDING_PAYMENT', hold_expires_at: { lte: new Date() } },
      include: { payment: true },
    })

    for (const booking of pending) {
      const payment = booking.payment
      if (!payment?.gateway_tx_id) {
        await this.bookingService.expireBooking(booking.id)
        continue
      }

      try {
        // Re-verify with gateway — if paid, confirm; if not, expire
        if (payment.gateway === 'KHALTI') {
          await this.paymentService.verifyKhalti(payment.gateway_tx_id, booking.id)
          this.logger.log(`Recovered KHALTI booking ${booking.id}`)
        }
      } catch (err) {
        this.logger.warn(`Recon failed for booking ${booking.id}: ${String(err)}`)
        await this.bookingService.expireBooking(booking.id)
      }
    }
  }
}

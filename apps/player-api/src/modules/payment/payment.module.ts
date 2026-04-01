// apps/player-api/src/modules/payment/payment.module.ts
import { Module } from '@nestjs/common'
import { PaymentService } from './payment.service.js'
import { PaymentController } from './payment.controller.js'
import { BookingModule } from '../booking/booking.module.js'

@Module({
  imports: [BookingModule],
  providers: [PaymentService],
  controllers: [PaymentController],
  exports: [PaymentService],
})
export class PaymentModule {}

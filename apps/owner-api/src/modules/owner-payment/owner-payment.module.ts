import { Module } from '@nestjs/common'
import { OwnerPaymentController } from './owner-payment.controller.js'
import { OwnerPaymentService } from './owner-payment.service.js'
import { OwnerAuthModule } from '../owner-auth/owner-auth.module.js'

@Module({
  imports: [OwnerAuthModule],
  controllers: [OwnerPaymentController],
  providers: [OwnerPaymentService],
})
export class OwnerPaymentModule {}

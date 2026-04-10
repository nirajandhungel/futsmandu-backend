import { Module } from '@nestjs/common'
import { AdminPaymentController } from './admin-payment.controller.js'
import { AdminPaymentService } from './admin-payment.service.js'
import { AdminAuthModule } from '../admin-auth/admin-auth.module.js'
import { RolesGuard } from '../../common/guards/roles.guard.js'
import { EsewaPayoutModule } from '@futsmandu/esewa-payout'

@Module({
  imports: [AdminAuthModule, EsewaPayoutModule],
  controllers: [AdminPaymentController],
  providers: [AdminPaymentService, RolesGuard],
})
export class AdminPaymentModule {}

import { Module } from '@nestjs/common'
import { AdminPaymentController } from './payment.controller.js'
import { AdminPaymentService } from './payment.service.js'
import { AdminAuthModule } from '../auth/auth.module.js'
import { RolesGuard } from '../../common/guards/roles.guard.js'
import { EsewaPayoutModule } from '@futsmandu/esewa-payout'

@Module({
  imports: [AdminAuthModule, EsewaPayoutModule],
  controllers: [AdminPaymentController],
  providers: [AdminPaymentService, RolesGuard],
})
export class AdminPaymentModule {}
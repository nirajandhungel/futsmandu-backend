import { Module } from '@nestjs/common'
import { PricingController } from './pricing.controller.js'
import { PricingService } from './pricing.service.js'
import { OwnerAuthModule } from '../owner-auth/owner-auth.module.js'
import { RolesGuard } from '../../common/guards/roles.guard.js'

@Module({
  imports: [OwnerAuthModule],
  controllers: [PricingController],
  providers: [PricingService, RolesGuard],
})
export class PricingModule {}

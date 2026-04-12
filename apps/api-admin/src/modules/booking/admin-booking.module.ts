import { Module } from '@nestjs/common'
import { AdminBookingController } from './admin-booking.controller.js'
import { AdminBookingService } from './admin-booking.service.js'
import { AdminAuthModule } from '../auth/auth.module.js'
import { RolesGuard } from '../../common/guards/roles.guard.js'

@Module({
  imports: [AdminAuthModule],
  controllers: [AdminBookingController],
  providers: [AdminBookingService, RolesGuard],
})
export class AdminBookingModule {}

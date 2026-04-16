import { Module } from '@nestjs/common'
import { BookingsController } from './bookings.controller.js'
import { BookingsService } from './bookings.service.js'
import { OwnerAuthModule } from '../owner-auth/owner-auth.module.js'
import { RolesGuard } from '../../common/guards/roles.guard.js'

@Module({
  imports: [OwnerAuthModule],
  controllers: [BookingsController],
  providers: [BookingsService, RolesGuard],
})
export class BookingsModule {}
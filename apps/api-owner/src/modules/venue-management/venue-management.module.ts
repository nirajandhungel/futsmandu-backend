import { Module } from '@nestjs/common'
import { VenueManagementController, CourtsController } from './venue-management.controller.js'
import { VenueManagementService } from './venue-management.service.js'
import { OwnerAuthModule } from '../owner-auth/owner-auth.module.js'
import { RolesGuard } from '../../common/guards/roles.guard.js'

@Module({
  imports: [OwnerAuthModule],
  controllers: [VenueManagementController, CourtsController],
  providers: [VenueManagementService, RolesGuard],
  exports: [VenueManagementService],
})
export class VenueManagementModule {}

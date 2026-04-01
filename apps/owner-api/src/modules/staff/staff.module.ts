import { Module } from '@nestjs/common'
import { StaffController } from './staff.controller.js'
import { StaffService } from './staff.service.js'
import { OwnerAuthModule } from '../owner-auth/owner-auth.module.js'
import { RolesGuard } from '../../common/guards/roles.guard.js'

@Module({
  imports: [OwnerAuthModule],
  controllers: [StaffController],
  providers: [StaffService, RolesGuard],
})
export class StaffModule {}

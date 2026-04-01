import { Module } from '@nestjs/common'
import { AdminUsersController } from './admin-users.controller.js'
import { AdminUsersService } from './admin-users.service.js'
import { AdminAuthModule } from '../admin-auth/admin-auth.module.js'
import { RolesGuard } from '../../common/guards/roles.guard.js'

@Module({
  imports: [AdminAuthModule],
  controllers: [AdminUsersController],
  providers: [AdminUsersService, RolesGuard],
})
export class AdminUsersModule {}

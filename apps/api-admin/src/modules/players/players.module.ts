import { Module } from '@nestjs/common'
import { AdminUsersController } from './players.controller.js'
import { AdminUsersService } from './players.service.js'
import { AdminAuthModule } from '../auth/auth.module.js'
import { RolesGuard } from '../../common/guards/roles.guard.js'

@Module({
  imports: [AdminAuthModule],
  controllers: [AdminUsersController],
  providers: [AdminUsersService, RolesGuard],
})
export class AdminUsersModule {}
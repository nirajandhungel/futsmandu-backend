import { Module } from '@nestjs/common'
import { AdminOwnersController } from './admin-owners.controller.js'
import { AdminOwnersService } from './admin-owners.service.js'
import { AdminAuthModule } from '../auth/auth.module.js'
import { RolesGuard } from '../../common/guards/roles.guard.js'

@Module({
  imports: [AdminAuthModule],
  controllers: [AdminOwnersController],
  providers: [AdminOwnersService, RolesGuard],
})
export class AdminOwnersModule {}

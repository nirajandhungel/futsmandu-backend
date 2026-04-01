import { Module } from '@nestjs/common'
import { AdminPenaltiesController } from './admin-penalties.controller.js'
import { AdminPenaltiesService } from './admin-penalties.service.js'
import { AdminAuthModule } from '../admin-auth/admin-auth.module.js'
import { RolesGuard } from '../../common/guards/roles.guard.js'

@Module({
  imports: [AdminAuthModule],
  controllers: [AdminPenaltiesController],
  providers: [AdminPenaltiesService, RolesGuard],
})
export class AdminPenaltiesModule {}

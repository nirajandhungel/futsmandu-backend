import { Module } from '@nestjs/common'
import { AdminPenaltiesController } from './penalties.controller.js'
import { AdminPenaltiesService } from './penalties.service.js'
import { AdminAuthModule } from '../auth/auth.module.js'
import { RolesGuard } from '../../common/guards/roles.guard.js'

@Module({
  imports: [AdminAuthModule],
  controllers: [AdminPenaltiesController],
  providers: [AdminPenaltiesService, RolesGuard],
})
export class AdminPenaltiesModule {}

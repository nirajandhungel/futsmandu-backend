import { Module } from '@nestjs/common'
import { AdminVenuesController } from './admin-venues.controller.js'
import { AdminVenuesService } from './admin-venues.service.js'
import { AdminAuthModule } from '../admin-auth/admin-auth.module.js'
import { RolesGuard } from '../../common/guards/roles.guard.js'
import { QueuesModule } from '../../queues.module.js'

@Module({
  imports: [
    AdminAuthModule,
    QueuesModule,
  ],
  controllers: [AdminVenuesController],
  providers: [AdminVenuesService, RolesGuard],
})
export class AdminVenuesModule {}

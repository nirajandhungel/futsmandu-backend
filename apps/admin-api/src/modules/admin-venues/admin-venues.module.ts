// apps/admin-api/src/modules/admin-venues/admin-venues.module.ts
// CHANGED: Added MediaModule so AdminVenuesService can inject MediaService.

import { Module } from '@nestjs/common'
import { AdminVenuesController } from './admin-venues.controller.js'
import { AdminVenuesService } from './admin-venues.service.js'
import { AdminAuthModule } from '../admin-auth/admin-auth.module.js'
import { RolesGuard } from '../../common/guards/roles.guard.js'
import { QueuesModule } from '@futsmandu/queues'
import { MediaModule } from '@futsmandu/media'

@Module({
  imports: [
    AdminAuthModule,
    QueuesModule,
    MediaModule,        // ← added
  ],
  controllers: [AdminVenuesController],
  providers:   [AdminVenuesService, RolesGuard],
})
export class AdminVenuesModule {}
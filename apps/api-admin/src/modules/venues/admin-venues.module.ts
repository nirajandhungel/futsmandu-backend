// apps/admin-api/src/modules/admin-venues/admin-venues.module.ts
// ─── ADDITIVE UPDATE ──────────────────────────────────────────────────────────
// No structural changes — MediaModule was already imported.
// Added MediaService to providers so controller can inject it directly
// for the debug endpoint. All other imports preserved.
// ─────────────────────────────────────────────────────────────────────────────

import { Module } from '@nestjs/common'
import { AdminVenuesController } from './admin-venues.controller.js'
import { AdminVenuesService } from './admin-venues.service.js'
import { AdminAuthModule } from '../auth/auth.module.js'
import { RolesGuard } from '../../common/guards/roles.guard.js'
import { QueuesModule } from '@futsmandu/queues'
import { MediaModule } from '@futsmandu/media'

@Module({
  imports: [
    AdminAuthModule,
    QueuesModule,
    MediaModule,   // provides MediaService and R2StorageService (via MediaModule → R2StorageModule)
  ],
  controllers: [AdminVenuesController],
  providers:   [AdminVenuesService, RolesGuard],
})
export class AdminVenuesModule {}
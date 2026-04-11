// apps/player-api/src/modules/venue/venue.module.ts
// ─── ADDITIVE UPDATE ──────────────────────────────────────────────────────────
// Added MediaModule import so VenueService can inject MediaService.
// ─────────────────────────────────────────────────────────────────────────────

import { Module } from '@nestjs/common'
import { VenueService } from './venue.service.js'
import { VenueController } from './venue.controller.js'
import { MediaModule } from '@futsmandu/media'

@Module({
  imports:     [MediaModule],         // ← NEW
  providers:   [VenueService],
  controllers: [VenueController],
})
export class VenueModule {}

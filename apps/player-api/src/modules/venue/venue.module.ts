// apps/player-api/src/modules/venue/venue.module.ts
import { Module } from '@nestjs/common'
import { VenueService } from './venue.service.js'
import { VenueController } from './venue.controller.js'

@Module({
  providers: [VenueService],
  controllers: [VenueController],
})
export class VenueModule {}

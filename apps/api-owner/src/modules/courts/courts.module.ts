// apps/owner-api/src/modules/courts/courts.module.ts
// Courts are managed separately from venues for cleaner SRP.
// Court CRUD is already in VenueManagementService — this module adds
// availability calendar and slot grid endpoints specific to court management.
import { Module } from '@nestjs/common'
import { CourtsController } from './courts.controller.js'
import { CourtsService } from './courts.service.js'

@Module({
  controllers: [CourtsController],
  providers: [CourtsService],
  exports: [CourtsService],
})
export class CourtsModule {}

// apps/player-api/src/modules/booking/booking.module.ts
import { Module } from '@nestjs/common'
import { BookingService } from './booking.service.js'
import { BookingLifecycleService } from './booking-lifecycle.service.js'
import { BookingMatchService } from './booking-match.service.js'
import { BookingController } from './booking.controller.js'
import { QueuesModule } from '@futsmandu/queues'

@Module({
  imports: [QueuesModule],
  providers: [BookingService, BookingLifecycleService, BookingMatchService],
  controllers: [BookingController],
  exports: [BookingService],
})
export class BookingModule {}

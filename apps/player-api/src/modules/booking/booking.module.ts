// apps/player-api/src/modules/booking/booking.module.ts
import { Module } from '@nestjs/common'
import { BookingService } from './booking.service.js'
import { BookingController } from './booking.controller.js'
import { QueuesModule } from '../../queues.module.js'

@Module({
  imports: [QueuesModule],
  providers: [BookingService],
  controllers: [BookingController],
  exports: [BookingService],
})
export class BookingModule {}

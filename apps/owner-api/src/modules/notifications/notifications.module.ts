// apps/owner-api/src/modules/notifications/notifications.module.ts
import { Module } from '@nestjs/common'
import { NotificationsService } from './notifications.service.js'
import { QueuesModule } from '../../queues.module.js'

@Module({
  imports: [
    QueuesModule,
  ],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}

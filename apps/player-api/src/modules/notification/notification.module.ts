// apps/player-api/src/modules/notification/notification.module.ts
import { Module } from '@nestjs/common'
import { NotificationService } from './notification.service.js'
import { NotificationController } from './notification.controller.js'
@Module({ providers: [NotificationService], controllers: [NotificationController] })
export class NotificationModule {}

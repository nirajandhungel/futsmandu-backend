// apps/admin-api/src/modules/media/media.module.ts

import { Module } from '@nestjs/common'
import { MediaModule as SharedMediaModule } from '@futsmandu/media'
import { MediaController } from './media.controller.js'

@Module({
  imports:     [SharedMediaModule],
  controllers: [MediaController],
})
export class MediaModule {}

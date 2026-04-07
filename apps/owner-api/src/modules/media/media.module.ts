// apps/owner-api/src/modules/media/media.module.ts
// REPLACES old media.module.ts
// No local MediaService — use @futsmandu/media directly.

import { Module } from '@nestjs/common'
import { MediaModule as SharedMediaModule } from '@futsmandu/media'
import { MediaController } from './media.controller.js'

@Module({
  imports:     [SharedMediaModule],
  controllers: [MediaController],
})
export class MediaModule {}
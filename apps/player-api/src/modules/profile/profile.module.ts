// apps/player-api/src/modules/profile/profile.module.ts
// CHANGED: Added MediaModule import so ProfileService can inject MediaService.

import { Module } from '@nestjs/common'
import { ProfileService } from './profile.service.js'
import { ProfileController } from './profile.controller.js'
import { MediaModule } from '@futsmandu/media'

@Module({
  imports:     [MediaModule],
  providers:   [ProfileService],
  controllers: [ProfileController],
})
export class ProfileModule {}
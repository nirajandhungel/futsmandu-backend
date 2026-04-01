// apps/player-api/src/modules/profile/profile.module.ts
import { Module } from '@nestjs/common'
import { ProfileService } from './profile.service.js'
import { ProfileController } from './profile.controller.js'
@Module({ providers: [ProfileService], controllers: [ProfileController] })
export class ProfileModule {}

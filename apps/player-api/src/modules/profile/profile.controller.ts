// apps/player-api/src/modules/profile/profile.controller.ts
import {
  Controller, Get, Put, Post, Body, Param, ParseUUIDPipe, HttpCode, HttpStatus,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger'
import { ProfileService, UpdateProfileDto } from './profile.service.js'
import { CurrentUser, Public } from '@futsmandu/auth'
import type { AuthenticatedUser } from '@futsmandu/types'

@ApiTags('Profile')
@ApiBearerAuth()
@Controller('profile')
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Get()
  getOwn(@CurrentUser() u: AuthenticatedUser) {
    return this.profileService.getOwn(u.id)
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  update(@CurrentUser() u: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    return this.profileService.update(u.id, dto)
  }

  @Public()
  @Get(':userId')
  getPublic(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.profileService.getPublic(userId)
  }

  @Post('avatar')
  @HttpCode(HttpStatus.OK)
  avatarUrl(@CurrentUser() u: AuthenticatedUser) {
    return this.profileService.getAvatarUploadUrl(u.id)
  }
}

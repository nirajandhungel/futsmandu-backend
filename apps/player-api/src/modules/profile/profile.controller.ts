// apps/player-api/src/modules/profile/profile.controller.ts
// CHANGED: Added POST /profile/avatar/confirm endpoint for the new 2-step upload flow.

import {
  Controller, Get, Put, Post, Body, Param, ParseUUIDPipe, HttpCode, HttpStatus,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { ProfileService, UpdateProfileDto } from './profile.service.js'
import { ConfirmUploadDto } from '../../dto/media.dto.js'
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

  // Step 1: Request presigned upload URL
  @Post('avatar/upload-url')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Step 1 — Get presigned R2 URL to upload profile image' })
  avatarUploadUrl(@CurrentUser() u: AuthenticatedUser) {
    return this.profileService.getAvatarUploadUrl(u.id)
  }

  // Step 2: Confirm upload complete
  @Post('avatar/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Step 2 — Confirm avatar upload, triggers resize job' })
  avatarConfirm(
    @CurrentUser() u: AuthenticatedUser,
    @Body() dto: ConfirmUploadDto,
  ) {
    return this.profileService.confirmAvatarUpload(u.id, dto.assetId, dto.key)
  }
}
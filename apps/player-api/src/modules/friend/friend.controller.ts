// apps/player-api/src/modules/friend/friend.controller.ts
import {
  Controller, Get, Post, Put, Delete,
  Body, Param, Query, ParseUUIDPipe, HttpCode, HttpStatus,
} from '@nestjs/common'
import { IsUUID } from 'class-validator'
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger'
import { FriendService } from './friend.service.js'
import { CurrentUser } from '@futsmandu/auth'
import type { AuthenticatedUser } from '@futsmandu/types'

class SendRequestDto { @IsUUID() recipientId!: string }

@ApiTags('Friends')
@ApiBearerAuth()
@Controller('friends')
export class FriendController {
  constructor(private readonly friendService: FriendService) {}

  @Get()
  list(@CurrentUser() u: AuthenticatedUser) {
    return this.friendService.list(u.id)
  }

  @Get('requests')
  requests(@CurrentUser() u: AuthenticatedUser) {
    return this.friendService.incomingRequests(u.id)
  }

  @Get('search')
  search(@Query('q') q: string, @Query('limit') limit?: number) {
    return this.friendService.search(q, limit)
  }

  @Post('request')
  @HttpCode(HttpStatus.CREATED)
  sendRequest(@CurrentUser() u: AuthenticatedUser, @Body() dto: SendRequestDto) {
    return this.friendService.sendRequest(u.id, dto.recipientId)
  }

  @Put(':id/accept')
  @HttpCode(HttpStatus.OK)
  accept(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.friendService.acceptRequest(id, u.id)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.friendService.remove(id, u.id)
  }

  @Post(':id/block')
  @HttpCode(HttpStatus.OK)
  block(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.friendService.block(u.id, id)
  }
}

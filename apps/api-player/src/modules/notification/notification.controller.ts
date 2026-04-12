// apps/player-api/src/modules/notification/notification.controller.ts
import { Controller, Get, Put, Param, ParseUUIDPipe, Query, HttpCode, HttpStatus } from '@nestjs/common'
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger'
import { NotificationService } from './notification.service.js'
import { CurrentUser } from '@futsmandu/auth'
import type { AuthenticatedUser } from '@futsmandu/types'

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notifService: NotificationService) {}

  @Get()
  list(
    @CurrentUser() u: AuthenticatedUser,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.notifService.list(u.id, page, limit)
  }

  @Put('read-all')
  @HttpCode(HttpStatus.OK)
  markAllRead(@CurrentUser() u: AuthenticatedUser) {
    return this.notifService.markAllRead(u.id)
  }

  @Put(':id/read')
  @HttpCode(HttpStatus.OK)
  markOneRead(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.notifService.markOneRead(id, u.id)
  }
}

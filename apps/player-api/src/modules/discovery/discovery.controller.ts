// apps/player-api/src/modules/discovery/discovery.controller.ts
import { Controller, Get, Query } from '@nestjs/common'
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger'
import { DiscoveryService } from './discovery.service.js'
import { CurrentUser } from '@futsmandu/auth'
import type { AuthenticatedUser } from '@futsmandu/types'

@ApiTags('Discovery')
@ApiBearerAuth()
@Controller('matches')
export class DiscoveryController {
  constructor(private readonly discoveryService: DiscoveryService) {}

  @Get('tonight')
  tonight(@CurrentUser() u: AuthenticatedUser, @Query('lat') lat: number, @Query('lng') lng: number) {
    return this.discoveryService.getTonightFeed(u.id, lat, lng)
  }

  @Get('tomorrow')
  tomorrow(@CurrentUser() u: AuthenticatedUser, @Query('lat') lat: number, @Query('lng') lng: number) {
    return this.discoveryService.getTomorrowFeed(u.id, lat, lng)
  }

  @Get('weekend')
  weekend(@CurrentUser() u: AuthenticatedUser, @Query('lat') lat: number, @Query('lng') lng: number) {
    return this.discoveryService.getWeekendFeed(u.id, lat, lng)
  }

  @Get('open')
  open(
    @CurrentUser() u: AuthenticatedUser,
    @Query('date') date?: string, @Query('skill') skill?: string,
    @Query('lat') lat?: number,   @Query('lng') lng?: number,
    @Query('cursor') cursor?: string, @Query('limit') limit?: number,
  ) {
    return this.discoveryService.getOpenMatches({ date, skill, lat, lng, cursor, limit })
  }
}

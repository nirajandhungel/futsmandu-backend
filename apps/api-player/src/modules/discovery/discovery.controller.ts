// apps/player-api/src/modules/discovery/discovery.controller.ts
// OPTIMISED:
//   - lat/lng/cursor/limit now validated via typed DTOs with @Type(() => Number)
//     (raw @Query('lat') lat: number is just a TS hint — query strings arrive as strings)
//   - @Public() + Cache-Control headers on all public/semi-public feeds
//   - open() endpoint now uses a proper DTO instead of loose individual params

import { Controller, Get, Query, Res } from '@nestjs/common'
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger'
import {
  IsOptional, IsNumber, IsString, IsEnum, Min, Max,
} from 'class-validator'
import { Type } from 'class-transformer'
import type { FastifyReply } from 'fastify'
import { DiscoveryService } from './discovery.service.js'
import { CurrentUser, Public } from '@futsmandu/auth'
import type { AuthenticatedUser } from '@futsmandu/types'
import { ENV } from '@futsmandu/utils'

// ── Query DTOs ────────────────────────────────────────────────────────────────

// Default map centre — from ENV (falls back to Kathmandu in env.config).
const DEFAULT_LAT = ENV.DISCOVERY_DEFAULT_LAT
const DEFAULT_LNG = ENV.DISCOVERY_DEFAULT_LNG

class GeoQueryDto {
  @IsOptional()
  @IsNumber() @Min(-90)  @Max(90)  @Type(() => Number) lat?: number
  @IsOptional()
  @IsNumber() @Min(-180) @Max(180) @Type(() => Number) lng?: number
}

class OpenMatchesQueryDto {
  @IsString()   @IsOptional() date?:   string
  @IsEnum(['beginner', 'intermediate', 'advanced']) @IsOptional() skill?: string
  @IsNumber()   @IsOptional() @Min(-90)  @Max(90)  @Type(() => Number) lat?:  number
  @IsNumber()   @IsOptional() @Min(-180) @Max(180) @Type(() => Number) lng?:  number
  @IsString()   @IsOptional() cursor?: string
  @IsNumber()   @IsOptional() @Min(1) @Max(50)    @Type(() => Number) limit?: number
}

// ── Controller ────────────────────────────────────────────────────────────────

@ApiTags('Discovery')
@ApiBearerAuth()
@Controller('matches')
export class DiscoveryController {
  constructor(private readonly discoveryService: DiscoveryService) {}

  // Tonight feed — cache 30s (public-ish; user-filtered server-side after cache)
  @Get('tonight')
  async tonight(
    @CurrentUser() u: AuthenticatedUser,
    @Query() geo: GeoQueryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'private, max-age=30')
    const lat = geo.lat ?? DEFAULT_LAT
    const lng = geo.lng ?? DEFAULT_LNG
    return this.discoveryService.getTonightFeed(u.id, lat, lng)
  }

  // Tomorrow feed — cache 60s (less time-sensitive)
  @Get('tomorrow')
  async tomorrow(
    @CurrentUser() u: AuthenticatedUser,
    @Query() geo: GeoQueryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'private, max-age=60')
    const lat = geo.lat ?? DEFAULT_LAT
    const lng = geo.lng ?? DEFAULT_LNG
    return this.discoveryService.getTomorrowFeed(u.id, lat, lng)
  }

  // Weekend feed — cache 120s (mostly static over hours)
  @Get('weekend')
  async weekend(
    @CurrentUser() u: AuthenticatedUser,
    @Query() geo: GeoQueryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'private, max-age=120')
    const lat = geo.lat ?? DEFAULT_LAT
    const lng = geo.lng ?? DEFAULT_LNG
    return this.discoveryService.getWeekendFeed(u.id, lat, lng)
  }

  // Open matches — public, CDN-cacheable for 30s
  @Public()
  @Get('open')
  async open(
    @Query() query: OpenMatchesQueryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60')
    return this.discoveryService.getOpenMatches(query)
  }
}

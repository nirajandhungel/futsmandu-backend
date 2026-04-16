// apps/player-api/src/modules/venue/venue.controller.ts
// OPTIMISED:
//   - Public GET endpoints now emit Cache-Control headers so CDN/proxy layers
//     can cache venue listings and detail pages (these rarely change per-request)
//   - page/limit query params typed with @Type(() => Number) so ValidationPipe
//     transforms them correctly instead of passing strings to the service
//   - Venue detail cached for 60s; listing for 30s (stale-while-revalidate=120)

import {
  Controller, Get, Post, Body, Param, Query,
  ParseUUIDPipe, HttpCode, HttpStatus, Res,
} from '@nestjs/common'
import { IsString, IsOptional, IsNumber, IsInt, Min, Max } from 'class-validator'
import { Type } from 'class-transformer'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import type { FastifyReply } from 'fastify'
import { VenueService } from './venue.service.js'
import { CurrentUser, Public } from '@futsmandu/auth'
import type { AuthenticatedUser } from '@futsmandu/types'

class VenueListQueryDto {
  @IsString()  @IsOptional() q?: string
  @IsInt()     @IsOptional() @Min(1)  @Type(() => Number) page?:  number
  @IsInt()     @IsOptional() @Min(1) @Max(50) @Type(() => Number) limit?: number
}

class WriteReviewDto {
  @IsString() bookingId!: string
  @IsNumber() @Min(1) @Max(5) rating!: number
  @IsString() @IsOptional() comment?: string
}

@ApiTags('Venues')
@ApiBearerAuth()
@Controller('venues')
export class VenueController {
  constructor(private readonly venueService: VenueService) { }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Browse venues with optional text search' })
  async list(
    @Query() q: VenueListQueryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    // Venue lists are semi-static — safe to cache 30s at edge
    reply.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=120')
    return this.venueService.list(q.q, q.page, q.limit)
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Venue detail with courts and recent reviews' })
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    // Detail is more expensive to compute; cache for 60s
    reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=120')
    return this.venueService.detail(id)
  }

  @Post(':id/reviews')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Write a post-match review (one per booking)' })
  writeReview(
    @Param('id', ParseUUIDPipe) venueId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WriteReviewDto,
  ) {
    return this.venueService.writeReview(venueId, user.id, dto.bookingId, dto.rating, dto.comment)
  }
}

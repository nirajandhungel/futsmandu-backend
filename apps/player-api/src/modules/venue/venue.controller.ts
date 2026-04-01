// apps/player-api/src/modules/venue/venue.controller.ts
import { Controller, Get, Post, Body, Param, Query, ParseUUIDPipe, HttpCode, HttpStatus } from '@nestjs/common'
import { IsString, IsOptional, IsNumber, IsInt, Min, Max } from 'class-validator'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { VenueService } from './venue.service.js'
import { CurrentUser, Public } from '@futsmandu/auth'
import type { AuthenticatedUser } from '@futsmandu/types'

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
  list(
    @Query('q') q?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.venueService.list(q, page, limit)
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Venue detail with courts and recent reviews' })
  detail(@Param('id', ParseUUIDPipe) id: string) {
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


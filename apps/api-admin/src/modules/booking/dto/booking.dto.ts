import {
  IsOptional, IsString, IsEnum, IsDateString, IsUUID,
  IsInt, Min, Max, MaxLength,
} from 'class-validator'
import { ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { booking_status, booking_source } from '@futsmandu/database'

export class ListBookingsQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number

  @ApiPropertyOptional({ enum: booking_status })
  @IsOptional()
  @IsEnum(booking_status)
  status?: booking_status

  // booking_type does not exist in schema — replaced by booking_source
  @ApiPropertyOptional({
    enum: booking_source,
    description: 'Filter by booking origin: PLAYER_SELF | GROUP_ADMIN | OFFLINE_COUNTER',
  })
  @IsOptional()
  @IsEnum(booking_source)
  bookingSource?: booking_source

  @ApiPropertyOptional({ description: 'Filter by venue UUID' })
  @IsOptional()
  @IsUUID('4')
  venueId?: string

  @ApiPropertyOptional({ description: 'Filter by player UUID' })
  @IsOptional()
  @IsUUID('4')
  playerId?: string

  @ApiPropertyOptional({ example: '2026-04-07' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string

  @ApiPropertyOptional({ example: '2026-04-30' })
  @IsOptional()
  @IsDateString()
  dateTo?: string

  @ApiPropertyOptional({ description: 'Search by booking id, player name/email/phone, venue name' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string
}

export class BookingOverviewQueryDto {
  @ApiPropertyOptional({ example: '2026-04-01' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string

  @ApiPropertyOptional({ example: '2026-04-30' })
  @IsOptional()
  @IsDateString()
  dateTo?: string

  @ApiPropertyOptional({ description: 'Optional venue UUID filter' })
  @IsOptional()
  @IsUUID('4')
  venueId?: string
}
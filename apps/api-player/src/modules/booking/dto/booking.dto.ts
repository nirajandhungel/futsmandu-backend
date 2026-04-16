// CHANGED: [SEC-2 BookingQueryDto with type coercion, M-2 base64 cursor, DTO hardening]
// NEW ISSUES FOUND:
//   - BookingListDto had no @Type(() => Number) on page/limit — NestJS passed string "abc" to service
//   - cursor was @IsUUID but cursor is now a base64-encoded created_at timestamp (M-2 fix)
//   - HoldSlotDto friendIds had no @ArrayMaxSize limit — unbounded array

// apps/player-api/src/modules/booking/dto/booking.dto.ts
import {
  IsUUID, IsDateString, Matches, IsArray, IsOptional,
  IsString, MaxLength, IsEnum, IsInt, Min, Max, IsIn,
  ArrayMaxSize,
} from 'class-validator'
import { Type, Transform } from 'class-transformer'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { booking_status, cost_split_mode, join_mode } from '@futsmandu/database'

export enum FlexibleBookingType {
  FULL = 'FULL',
  PARTIAL = 'PARTIAL',
  FLEX = 'FLEX',
}

export class HoldSlotDto {
  @ApiProperty()
  @IsUUID('4')
  courtId!: string

  @ApiProperty({ example: '2025-10-10' })
  @IsDateString()
  date!: string

  @ApiProperty({ example: '17:00' })
  @Matches(/^\d{2}:\d{2}$/, { message: 'Use HH:MM format' })
  @IsString()
  startTime!: string

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(9, { message: 'Maximum 9 friends per booking' })
  @IsUUID('4', { each: true })
  friendIds?: string[]

  @ApiPropertyOptional({ enum: FlexibleBookingType, default: FlexibleBookingType.FLEX })
  @IsOptional()
  @IsEnum(FlexibleBookingType)
  bookingType?: FlexibleBookingType

  @ApiPropertyOptional({ minimum: 2, maximum: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(30)
  requiredPlayers?: number

  @ApiPropertyOptional({ minimum: 2, maximum: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(30)
  maxPlayers?: number

  @ApiPropertyOptional({ enum: join_mode, default: 'INVITE_ONLY' })
  @IsOptional()
  @IsEnum(join_mode)
  joinMode?: join_mode

  @ApiPropertyOptional({ enum: cost_split_mode, default: 'ADMIN_PAYS_ALL' })
  @IsOptional()
  @IsEnum(cost_split_mode)
  costSplitMode?: cost_split_mode

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string
}

export class CancelBookingDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  reason?: string
}

// SEC-2: Proper query param DTO with type coercion and bounds.
// @Type(() => Number) ensures NestJS coerces query string "10" → number 10.
// Without it, arithmetic on string "10" produces NaN silently.
export class BookingQueryDto {
  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number

  @ApiPropertyOptional({ minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number

  @ApiPropertyOptional({ enum: booking_status })
  @IsOptional()
  @IsEnum(booking_status)
  status?: booking_status

  // M-2: cursor is base64-encoded created_at ISO string, not a UUID
  @ApiPropertyOptional({ description: 'Base64-encoded created_at cursor from previous page' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string
}

export class RequestJoinDto {
  @ApiProperty()
  @IsUUID('4')
  matchGroupId!: string

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  message?: string
}

export class RespondJoinRequestDto {
  @ApiProperty()
  @IsUUID('4')
  requestId!: string

  @ApiProperty({ enum: ['ACCEPT', 'REJECT'] })
  @IsIn(['ACCEPT', 'REJECT'])
  action!: 'ACCEPT' | 'REJECT'
}

export class AddFriendToMatchDto {
  @ApiProperty()
  @IsUUID('4')
  matchGroupId!: string

  @ApiProperty()
  @IsUUID('4')
  friendId!: string
}

export class OpenMatchesQueryDto {
  @ApiPropertyOptional({ example: '2026-04-07' })
  @IsOptional()
  @IsDateString()
  date?: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  venueId?: string

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number

  @ApiPropertyOptional({ minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number
}
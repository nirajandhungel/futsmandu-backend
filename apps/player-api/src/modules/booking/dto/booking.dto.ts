// CHANGED: [SEC-2 BookingQueryDto with type coercion, M-2 base64 cursor, DTO hardening]
// NEW ISSUES FOUND:
//   - BookingListDto had no @Type(() => Number) on page/limit — NestJS passed string "abc" to service
//   - cursor was @IsUUID but cursor is now a base64-encoded created_at timestamp (M-2 fix)
//   - HoldSlotDto friendIds had no @ArrayMaxSize limit — unbounded array

// apps/player-api/src/modules/booking/dto/booking.dto.ts
import {
  IsUUID, IsDateString, Matches, IsArray, IsOptional,
  IsString, MaxLength, IsEnum, IsInt, Min, Max, IsBase64,
  ArrayMaxSize, IsNotEmpty,
} from 'class-validator'
import { Type, Transform } from 'class-transformer'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { booking_status } from '@futsmandu/database'

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

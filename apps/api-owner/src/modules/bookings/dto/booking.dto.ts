// CHANGED: [SEC-6 start_time @Matches HH:MM, DTO hardening @Transform trim, @IsEnum for status]
// NEW ISSUES FOUND:
//   - start_time accepted "99:99", "abc", etc. — no format validation (SEC-6)
//   - status used @IsIn([...]) string array instead of @IsEnum — no type safety
//   - customer_phone had @MaxLength(15) but no phone format validation
//   - ListBookingsQueryDto page had no @IsInt or @Min validation

// apps/owner-admin-api/src/modules/bookings/dto/booking.dto.ts
import {
  IsString, IsNotEmpty, IsDateString, IsIn, IsOptional,
  IsArray, MaxLength, IsUUID, IsInt, Min, Matches, IsEnum,
} from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type, Transform } from 'class-transformer'

export class CalendarQueryDto {
  @ApiProperty({ example: '2025-10-10' })
  @IsDateString()
  date!: string
}

export class CreateOfflineBookingDto {
  @ApiProperty()
  @IsUUID('4')
  court_id!: string

  @ApiProperty({ example: '2025-10-10' })
  @IsDateString()
  booking_date!: string

  // SEC-6: Validates HH:MM format — rejects "99:99", "abc", "17:0", etc.
  @ApiProperty({ example: '17:00' })
  @Matches(/^\d{2}:\d{2}$/, { message: 'Use HH:MM format (e.g. 17:00)' })
  @IsString()
  start_time!: string

  @ApiProperty({ enum: ['offline_cash', 'offline_paid', 'offline_reserved'] })
  @IsIn(['offline_cash', 'offline_paid', 'offline_reserved'])
  booking_type!: string

  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @IsNotEmpty() @MaxLength(100)
  customer_name!: string

  @ApiProperty({ description: 'Nepal phone number' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @IsNotEmpty()
  @Matches(/^\+?977\d{9,10}$|^\d{9,10}$/, { message: 'Invalid Nepal phone number' })
  customer_phone!: string

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MaxLength(300)
  notes?: string
}

export class ListBookingsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  date?: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  courtId?: string

  @ApiPropertyOptional({
    enum: ['HELD', 'PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'NO_SHOW', 'COMPLETED'],
  })
  @IsOptional()
  @IsIn(['HELD', 'PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'NO_SHOW', 'COMPLETED'])
  status?: string

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number
}

export class MarkAttendanceDto {
  @ApiProperty({ description: 'Array of player_ids who did not show up' })
  @IsArray()
  @IsUUID('4', { each: true })
  no_show_ids!: string[]
}

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

  // Schema payment_method enum: CASH | KHALTI | ESEWA | BANK_TRANSFER
  // For offline (counter) bookings, CASH is the typical value.
  @ApiProperty({ enum: ['CASH', 'KHALTI', 'ESEWA', 'BANK_TRANSFER'], example: 'CASH' })
  @IsIn(['CASH', 'KHALTI', 'ESEWA', 'BANK_TRANSFER'])
  payment_method!: string

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

  @ApiPropertyOptional({ maxLength: 80, description: 'Booking name shown to staff (e.g. “Nirajan Booking”)' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(80)
  booking_name?: string
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

  // Full booking_status enum from schema
  @ApiPropertyOptional({
    enum: ['HELD', 'PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'NO_SHOW', 'COMPLETED'],
  })
  @IsOptional()
  @IsIn(['HELD', 'PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'NO_SHOW', 'COMPLETED'])
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
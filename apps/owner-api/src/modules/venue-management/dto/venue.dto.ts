// CHANGED: [SEC-7 open_time/close_time @Matches HH:MM on courts, SEC-8 mass assignment check]
// NEW ISSUES FOUND:
//   - CreateCourtDto.open_time and close_time accepted any string (SEC-7)
//   - UpdateCourtDto same gap
//   - UpdateVenueDto could accept is_verified if spread unsafely in the service (SEC-8 guard at DTO level)
//   - CreateVenueDto amenities array items had no MaxLength per element

// apps/owner-admin-api/src/modules/venue-management/dto/venue.dto.ts
import {
  IsString, IsNotEmpty, IsOptional, IsArray, IsNumber,
  IsBoolean, MaxLength, IsObject, Min, Max, Matches,
} from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type, Transform } from 'class-transformer'

export class AddressDto {
  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @IsNotEmpty() @MaxLength(200)
  street!: string

  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @IsNotEmpty() @MaxLength(100)
  city!: string

  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @IsNotEmpty() @MaxLength(100)
  district!: string
}

export class CreateVenueDto {
  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @IsNotEmpty() @MaxLength(120)
  name!: string

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MaxLength(500)
  description?: string

  @ApiProperty()
  @IsObject()
  @Type(() => AddressDto)
  address!: AddressDto

  @ApiPropertyOptional()
  @IsOptional() @IsNumber() @Min(-90) @Max(90)
  latitude?: number

  @ApiPropertyOptional()
  @IsOptional() @IsNumber() @Min(-180) @Max(180)
  longitude?: number

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  amenities?: string[]

  @ApiPropertyOptional()
  @IsOptional() @IsNumber() @Min(0) @Max(168)
  full_refund_hours?: number

  @ApiPropertyOptional()
  @IsOptional() @IsNumber() @Min(0) @Max(72)
  partial_refund_hours?: number

  @ApiPropertyOptional()
  @IsOptional() @IsNumber() @Min(0) @Max(100)
  partial_refund_pct?: number
}

// SEC-8: is_verified deliberately excluded — owners cannot self-verify.
// Only admin service can flip is_verified via a separate endpoint.
export class UpdateVenueDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MaxLength(120)
  name?: string

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MaxLength(500)
  description?: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  address?: AddressDto

  @ApiPropertyOptional()
  @IsOptional() @IsNumber() @Min(-90) @Max(90)
  latitude?: number

  @ApiPropertyOptional()
  @IsOptional() @IsNumber() @Min(-180) @Max(180)
  longitude?: number

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  amenities?: string[]

  @ApiPropertyOptional()
  @IsOptional() @IsNumber() @Min(0) @Max(168)
  full_refund_hours?: number

  @ApiPropertyOptional()
  @IsOptional() @IsNumber() @Min(0) @Max(72)
  partial_refund_hours?: number

  @ApiPropertyOptional()
  @IsOptional() @IsNumber() @Min(0) @Max(100)
  partial_refund_pct?: number
}

export class CreateCourtDto {
  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @IsNotEmpty() @MaxLength(80)
  name!: string

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(20)
  court_type?: string

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(20)
  surface?: string

  @ApiPropertyOptional()
  @IsOptional() @IsNumber() @Min(2) @Max(30)
  capacity?: number

  @ApiPropertyOptional()
  @IsOptional() @IsNumber() @Min(2) @Max(22)
  min_players?: number

  @ApiPropertyOptional()
  @IsOptional() @IsNumber() @Min(30) @Max(180)
  slot_duration_mins?: number

  // SEC-7: Validates HH:MM format for court operating hours
  @ApiPropertyOptional({ example: '06:00' })
  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/, { message: 'open_time must be in HH:MM format (e.g. 06:00)' })
  @IsString()
  open_time?: string

  @ApiPropertyOptional({ example: '22:00' })
  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/, { message: 'close_time must be in HH:MM format (e.g. 22:00)' })
  @IsString()
  close_time?: string
}

export class UpdateCourtDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MaxLength(80)
  name?: string

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(20)
  court_type?: string

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(20)
  surface?: string

  @ApiPropertyOptional()
  @IsOptional() @IsNumber() @Min(2) @Max(30)
  capacity?: number

  @ApiPropertyOptional()
  @IsOptional() @IsNumber() @Min(2) @Max(22)
  min_players?: number

  @ApiPropertyOptional()
  @IsOptional() @IsNumber() @Min(30) @Max(180)
  slot_duration_mins?: number

  // SEC-7: Same HH:MM validation on update
  @ApiPropertyOptional({ example: '06:00' })
  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/, { message: 'open_time must be in HH:MM format' })
  @IsString()
  open_time?: string

  @ApiPropertyOptional({ example: '22:00' })
  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/, { message: 'close_time must be in HH:MM format' })
  @IsString()
  close_time?: string
}

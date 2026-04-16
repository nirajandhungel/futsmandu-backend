import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator'

const PAYOUT_STATUS_VALUES = ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'MANUALLY_RESOLVED'] as const

export class RetryPayoutDto {}

export class ResolvePayoutDto {
  @ApiProperty()
  @IsString()
  @MaxLength(500)
  note!: string
}

export class UpdatePlatformConfigDto {
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  value!: string
}

export class ListPayoutsQueryDto {
  @ApiPropertyOptional({ enum: PAYOUT_STATUS_VALUES })
  @IsOptional()
  @IsEnum(PAYOUT_STATUS_VALUES)
  status?: (typeof PAYOUT_STATUS_VALUES)[number]

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  ownerId?: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  venueId?: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  bookingId?: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  paymentId?: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  cursor?: string

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number
}
import { ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator'

const PAYOUT_STATUS_VALUES = ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'MANUALLY_RESOLVED'] as const

export class ListOwnerPayoutsQueryDto {
  @ApiPropertyOptional({ enum: PAYOUT_STATUS_VALUES })
  @IsOptional()
  @IsEnum(PAYOUT_STATUS_VALUES)
  status?: (typeof PAYOUT_STATUS_VALUES)[number]

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  venueId?: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  cursor?: string

  @ApiPropertyOptional({ default: 20, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number
}
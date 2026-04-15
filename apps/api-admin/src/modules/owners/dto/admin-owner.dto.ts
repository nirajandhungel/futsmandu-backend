import {
  IsOptional, IsString, IsEnum, IsInt, IsNotEmpty,
  Min, Max, MaxLength,
} from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'

const OWNER_STATUS_VALUES = ['pending', 'verified', 'suspended'] as const

const SORT_BY_VALUES = ['created_at', 'name', 'email', 'business_name'] as const
const SORT_ORDER_VALUES = ['asc', 'desc'] as const

export class ListOwnersQueryDto {
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

  @ApiPropertyOptional({ enum: OWNER_STATUS_VALUES })
  @IsOptional()
  @IsEnum(OWNER_STATUS_VALUES)
  status?: (typeof OWNER_STATUS_VALUES)[number]

  @ApiPropertyOptional({ description: 'Search by name, email, phone, or business name' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string

  @ApiPropertyOptional({ enum: SORT_BY_VALUES, default: 'created_at' })
  @IsOptional()
  @IsEnum(SORT_BY_VALUES)
  sortBy?: (typeof SORT_BY_VALUES)[number]

  @ApiPropertyOptional({ enum: SORT_ORDER_VALUES, default: 'desc' })
  @IsOptional()
  @IsEnum(SORT_ORDER_VALUES)
  sortOrder?: (typeof SORT_ORDER_VALUES)[number]
}

export class SuspendOwnerDto {
  @ApiProperty({ description: 'Reason for suspension (required)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string
}

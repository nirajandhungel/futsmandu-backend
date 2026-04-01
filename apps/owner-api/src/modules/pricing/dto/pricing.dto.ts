import {
  IsString, IsNotEmpty, IsOptional, IsArray, IsNumber,
  IsBoolean, IsIn, Min, Max, IsDateString,
} from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'

export class CreatePricingRuleDto {
  @ApiProperty({ description: 'base | offpeak | weekend | peak | lastminute | custom' })
  @IsIn(['base', 'offpeak', 'weekend', 'peak', 'lastminute', 'custom'])
  rule_type!: string

  @ApiProperty({ description: 'Priority: base=1 offpeak=5 weekend=8 peak=10 lastminute=15 custom=20' })
  @IsNumber() @Min(1) @Max(20)
  priority!: number

  @ApiProperty({ description: 'Price in paisa (NPR × 100)' })
  @IsNumber() @Min(100)
  price!: number

  @ApiProperty({ enum: ['fixed', 'percent_add', 'percent_off'] })
  @IsIn(['fixed', 'percent_add', 'percent_off'])
  modifier!: string

  @ApiPropertyOptional({ description: 'Days of week: 0=Sun ... 6=Sat' })
  @IsOptional() @IsArray() @IsNumber({}, { each: true })
  days_of_week?: number[]

  @ApiPropertyOptional() @IsOptional() @IsString() start_time?: string
  @ApiPropertyOptional() @IsOptional() @IsString() end_time?: string
  @ApiPropertyOptional() @IsOptional() @IsDateString() date_from?: string
  @ApiPropertyOptional() @IsOptional() @IsDateString() date_to?: string
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(1) hours_before?: number
}

export class UpdatePricingRuleDto {
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(100) price?: number
  @ApiPropertyOptional() @IsOptional() @IsIn(['fixed', 'percent_add', 'percent_off']) modifier?: string
  @ApiPropertyOptional() @IsOptional() @IsArray() days_of_week?: number[]
  @ApiPropertyOptional() @IsOptional() @IsString() start_time?: string
  @ApiPropertyOptional() @IsOptional() @IsString() end_time?: string
  @ApiPropertyOptional() @IsOptional() @IsDateString() date_from?: string
  @ApiPropertyOptional() @IsOptional() @IsDateString() date_to?: string
  @ApiPropertyOptional() @IsOptional() @IsNumber() hours_before?: number
  @ApiPropertyOptional() @IsOptional() @IsBoolean() is_active?: boolean
}

export class PricingPreviewQueryDto {
  @ApiProperty({ example: '2025-10-10' }) @IsDateString() date!: string
  @ApiProperty({ example: '17:00' }) @IsString() @IsNotEmpty() time!: string
}

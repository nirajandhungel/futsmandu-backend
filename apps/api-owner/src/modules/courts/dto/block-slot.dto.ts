import { IsDateString, IsEnum, IsOptional, IsString, Matches } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'

export enum BlockType {
  MAINTENANCE         = 'MAINTENANCE',
  PRIVATE_RESERVATION = 'PRIVATE_RESERVATION',
  EVENT               = 'EVENT',
  PERSONAL            = 'PERSONAL',
}

export class BlockSlotDto {
  @ApiProperty({ example: '2026-05-01' })
  @IsDateString()
  date!: string

  @ApiProperty({ example: '08:00' })
  @Matches(/^\d{2}:\d{2}$/, { message: 'Use HH:MM format (e.g. 08:00)' })
  @IsString()
  startTime!: string

  @ApiProperty({ enum: BlockType })
  @IsEnum(BlockType)
  block_type!: BlockType

  @ApiPropertyOptional({ example: 'Replacing turf netting' })
  @IsOptional()
  @IsString()
  note?: string
}
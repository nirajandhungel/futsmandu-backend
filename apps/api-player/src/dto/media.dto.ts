// apps/player-api/src/dto/media.dto.ts

import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export class RequestUploadUrlDto {
  @ApiPropertyOptional({
    enum:        ALLOWED_CONTENT_TYPES,
    description: 'MIME type of the image. Defaults to image/jpeg.',
  })
  @IsEnum(ALLOWED_CONTENT_TYPES)
  @IsOptional()
  contentType?: (typeof ALLOWED_CONTENT_TYPES)[number]
}

export class ConfirmUploadDto {
  @ApiProperty()
  @IsUUID()
  assetId!: string

  @ApiProperty({ example: 'players/uuid/profile/uuid.jpg' })
  @IsString()
  key!: string
}

export class DeleteAssetDto {
  @ApiProperty()
  @IsUUID()
  assetId!: string
}

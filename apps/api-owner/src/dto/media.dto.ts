// apps/owner-api/src/dto/media.dto.ts

import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { KycDocType } from '@futsmandu/media-core'

const OWNER_ASSET_TYPES = [
  'owner_profile',
  'kyc_document',
  'venue_cover',
  'venue_gallery',
  'venue_verification',
] as const

type OwnerAssetType = (typeof OWNER_ASSET_TYPES)[number]

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const
const KYC_DOC_TYPES         = ['citizenship', 'business_registration', 'business_pan'] as const

export class RequestUploadUrlDto {
  @ApiProperty({ enum: OWNER_ASSET_TYPES })
  @IsEnum(OWNER_ASSET_TYPES)
  assetType!: OwnerAssetType

  @ApiProperty({
    description: 'ownerId for profile/kyc, venueId for venue assets',
    example:     '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsString()
  entityId!: string

  @ApiPropertyOptional({ enum: KYC_DOC_TYPES, description: 'Required when assetType = kyc_document' })
  @IsEnum(KYC_DOC_TYPES)
  @IsOptional()
  docType?: KycDocType

  @ApiPropertyOptional({
    enum:        ALLOWED_CONTENT_TYPES,
    description: 'MIME type. Defaults to image/jpeg for images, application/pdf for kyc_document.',
  })
  @IsEnum(ALLOWED_CONTENT_TYPES)
  @IsOptional()
  contentType?: (typeof ALLOWED_CONTENT_TYPES)[number]
}

export class ConfirmUploadDto {
  @ApiProperty({ description: 'assetId returned by upload-url' })
  @IsUUID()
  assetId!: string

  @ApiProperty({ example: 'venues/uuid/cover/uuid.jpg' })
  @IsString()
  key!: string

  @ApiProperty({ enum: OWNER_ASSET_TYPES })
  @IsEnum(OWNER_ASSET_TYPES)
  assetType!: OwnerAssetType
}

export class OwnerKycUploadUrlDto {
  @ApiProperty({ enum: KYC_DOC_TYPES })
  @IsEnum(KYC_DOC_TYPES)
  docType!: KycDocType

  @ApiPropertyOptional({ enum: ALLOWED_CONTENT_TYPES })
  @IsEnum(ALLOWED_CONTENT_TYPES)
  @IsOptional()
  contentType?: (typeof ALLOWED_CONTENT_TYPES)[number]
}

export class DeleteAssetDto {
  @ApiProperty()
  @IsUUID()
  assetId!: string
}

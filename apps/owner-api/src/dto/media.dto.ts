// owner-api/src/dto/media.dto.ts
// UPDATED: Improved Swagger descriptions. No logic changes.

import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { KycDocType } from '@futsmandu/media-core'
import { OWNER_ASSET_TYPES,OwnerAssetType } from '../modules/media/owner-asset-types.js'
export class RequestUploadUrlDto {
  @ApiProperty({
    enum: OWNER_ASSET_TYPES,
    description: 'Type of asset to upload',
  })
  @IsEnum(OWNER_ASSET_TYPES)
  assetType!: OwnerAssetType

  @ApiProperty({
    description: 'Context-dependent entity ID: ownerId for profile/kyc, venueId for venue assets',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsString()
  entityId!: string

  @ApiPropertyOptional({
    enum: ['citizenship', 'business_registration', 'business_pan'],
    description: 'Required when assetType = kyc_document',
  })
  @IsEnum(['citizenship', 'business_registration', 'business_pan'])
  @IsOptional()
  docType?: KycDocType

  @ApiPropertyOptional({
    enum: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    description: 'MIME type of the file you intend to upload. Defaults to image/jpeg for images, application/pdf for kyc_document.',
  })
  @IsEnum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
  @IsOptional()
  contentType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf'
}

export class ConfirmUploadDto {
  @ApiProperty({
    description: 'The media_assets.id returned by upload-url',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID()
  assetId!: string

  @ApiProperty({
    description: 'The key value returned by the upload-url endpoint',
    example: 'venues/550e8400-e29b-41d4-a716-446655440000/cover/abc123.jpg',
  })
  @IsString()
  key!: string

  @ApiProperty({
    enum: OWNER_ASSET_TYPES,
    description: 'Must match the assetType used when requesting the upload URL',
  })
  @IsEnum(OWNER_ASSET_TYPES)
  assetType!: OwnerAssetType
}

export class OwnerKycUploadUrlDto {
  @ApiProperty({
    enum: ['citizenship', 'business_registration', 'business_pan'],
    description: 'Type of KYC document',
  })
  @IsEnum(['citizenship', 'business_registration', 'business_pan'])
  docType!: KycDocType

  @ApiPropertyOptional({
    enum: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    description: 'MIME type of the file you intend to upload. Defaults to application/pdf.',
  })
  @IsEnum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
  @IsOptional()
  contentType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf'
}

export class DeleteAssetDto {
  @ApiProperty({ description: 'UUID of the media_asset record to delete' })
  @IsUUID()
  assetId!: string
}

export class AssetStatusDto {
  @ApiProperty({ description: 'UUID of the media_asset record' })
  @IsUUID()
  assetId!: string
}

import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { AssetType, KycDocType } from '@futsmandu/media-core'

export class RequestUploadUrlDto {
  @ApiProperty({ enum: ['player_profile','owner_profile','venue_cover','venue_gallery','venue_verification','kyc_document'] })
  @IsEnum(['player_profile','owner_profile','venue_cover','venue_gallery','venue_verification','kyc_document'])
  assetType!: AssetType;

  @ApiProperty({ description: 'playerId, ownerId, or venueId depending on assetType' })
  @IsString()
  entityId!: string;

  @ApiPropertyOptional({ enum: ['citizenship','business_registration','business_pan'], description: 'Type of KYC document' })
  @IsEnum(['citizenship','business_registration','business_pan'])
  @IsOptional()
  docType?: KycDocType;

  @ApiPropertyOptional({ enum: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] })
  @IsEnum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
  @IsOptional()
  contentType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
}

export class ConfirmUploadDto {
  @ApiProperty()
  @IsString()
  key!: string

  @ApiProperty({ enum: ['player_profile','owner_profile','venue_cover','venue_gallery','venue_verification','kyc_document'] })
  @IsEnum(['player_profile','owner_profile','venue_cover','venue_gallery','venue_verification','kyc_document'])
  assetType!: AssetType
}

export class OwnerKycUploadUrlDto {
  @ApiProperty({ enum: ['citizenship','business_registration','business_pan'] })
  @IsEnum(['citizenship','business_registration','business_pan'])
  docType!: KycDocType

  @ApiPropertyOptional({ enum: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] })
  @IsEnum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
  @IsOptional()
  contentType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
}

export class DeleteAssetDto {
  @ApiProperty()
  @IsUUID()
  assetId!: string
}

export class AssetStatusDto {
  @ApiProperty()
  @IsUUID()
  assetId!: string
}

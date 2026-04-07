import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { AssetType, KycDocType } from '@futsmandu/media-core'

export class RequestUploadUrlDto {
  @ApiProperty({ enum: ['player_profile','owner_profile','venue_cover','venue_gallery','venue_verification','kyc_document'] })
  @IsEnum(['player_profile','owner_profile','venue_cover','venue_gallery','venue_verification','kyc_document'])
  assetType!: AssetType

  @ApiProperty({ description: 'playerId, ownerId, or venueId depending on assetType' })
  @IsString()
  entityId!: string

  @ApiPropertyOptional({ enum: ['nid_front','nid_back','business_registration','tax_certificate'] })
  @IsEnum(['nid_front','nid_back','business_registration','tax_certificate'])
  @IsOptional()
  docType?: KycDocType
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
  @ApiProperty({ enum: ['nid_front','nid_back','business_registration','tax_certificate'] })
  @IsEnum(['nid_front','nid_back','business_registration','tax_certificate'])
  docType!: KycDocType
}

export class DeleteAssetDto {
  @ApiProperty()
  @IsUUID()
  assetId!: string
}

import { IsEnum, IsString, IsUUID } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { AssetType } from '@futsmandu/media-core'

export class RequestUploadUrlDto {
  @ApiProperty({ enum: ['player_profile'] })
  @IsEnum(['player_profile'])
  assetType!: AssetType

  @ApiProperty({ description: 'playerId' })
  @IsString()
  entityId!: string
}

export class ConfirmUploadDto {
  @ApiProperty()
  @IsUUID()
  assetId!: string

  @ApiProperty()
  @IsString()
  key!: string

  @ApiProperty({ enum: ['player_profile'] })
  @IsEnum(['player_profile'])
  assetType!: AssetType
}

export class DeleteAssetDto {
  @ApiProperty()
  @IsUUID()
  assetId!: string
}

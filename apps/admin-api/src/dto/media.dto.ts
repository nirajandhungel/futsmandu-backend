import { IsString } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class SignedDownloadDto {
  @ApiProperty({ description: 'R2 object key for the private asset' })
  @IsString()
  key!: string
}

import { IsEmail, IsString, IsNotEmpty, MinLength, IsOptional } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'

export class AdminLoginDto {
  @ApiProperty() @IsEmail() email!: string
  @ApiProperty() @IsString() @MinLength(8) password!: string
  @ApiPropertyOptional({ description: '6-digit 2FA code (placeholder for future TOTP)' })
  @IsOptional() @IsString() totpCode?: string
}

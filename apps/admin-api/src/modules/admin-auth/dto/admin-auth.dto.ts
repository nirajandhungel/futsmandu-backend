import {
  IsEmail, IsString, IsNotEmpty, MinLength, IsOptional, IsUUID, Matches,
} from 'class-validator'
import { Transform } from 'class-transformer'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'

export class AdminLoginDto {
  @ApiProperty() @IsEmail() email!: string
  @ApiProperty() @IsString() @MinLength(8) password!: string
  @ApiPropertyOptional({ description: '6-digit 2FA code (placeholder for future TOTP)' })
  @IsOptional() @IsString() totpCode?: string
}

// ── OTP Verification DTOs ────────────────────────────────────────────────────

export class VerifyOtpDto {
  @ApiProperty({ description: 'Admin ID', format: 'uuid' })
  @IsUUID('4')
  adminId!: string

  @ApiProperty({ description: '6-digit OTP code', example: '123456' })
  @IsString() @IsNotEmpty()
  @Matches(/^\d{6,10}$/, { message: 'OTP must be 6-10 digits' })
  otp!: string
}

export class ResendOtpDto {
  @ApiProperty({ description: 'Admin ID', format: 'uuid' })
  @IsUUID('4')
  adminId!: string

  @ApiProperty({ description: 'Admin email', example: 'admin@example.com' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  email!: string
}

// CHANGED: [DTO hardening — phone format, @Transform trim, password MaxLength]
// NEW ISSUES FOUND:
//   - RegisterOwnerDto phone had @MinLength(10) @MaxLength(10) but no Nepal phone regex
//   - No @Transform(trim) on name/email — whitespace-only values bypassed @IsNotEmpty
//   - password had no MaxLength — bcrypt DoS vector (truncates at 72 bytes silently)

// apps/owner-admin-api/src/modules/owner-auth/dto/owner-auth.dto.ts
import {
  IsEmail, IsString, IsNotEmpty, MinLength, MaxLength,
  IsOptional, IsIn, Matches,
} from 'class-validator'
import { Transform } from 'class-transformer'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'

export class RegisterOwnerDto {
  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @IsNotEmpty() @MaxLength(100)
  name!: string

  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  email!: string

  @ApiProperty({ example: '9841234567' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/^\+?977\d{9,10}$|^\d{9,10}$/, { message: 'Invalid Nepal phone number' })
  phone!: string

  @ApiProperty({ minLength: 8 })
  @IsString() @MinLength(8) @MaxLength(64)
  password!: string

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MaxLength(150)
  business_name?: string
}

export class LoginOwnerDto {
  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  email!: string

  @ApiProperty()
  @IsString() @IsNotEmpty() @MaxLength(128)
  password!: string
}

export class RefreshTokenDto {
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  refreshToken?: string
}

export class UploadDocDto {
  @ApiProperty({ enum: ['citizenship', 'pan', 'business_reg', 'other'] })
  @IsIn(['citizenship', 'pan', 'business_reg', 'other'])
  docType!: string
}

// CHANGED: [DTO hardening — @Transform trim, @IsNotEmpty on all required strings]
// NEW ISSUES FOUND:
//   - name/email fields had no @Transform(trim) — whitespace-only values bypassed @IsNotEmpty
//   - LoginDto password had no MaxLength — unbounded string could cause bcrypt DoS (bcrypt
//     has a 72-byte internal limit; inputs beyond that are silently truncated, but we enforce
//     MaxLength at the API layer to reject obviously malicious payloads early)

// apps/player-api/src/modules/auth/dto/auth.dto.ts
import {
  IsEmail, IsString, MinLength, MaxLength, Matches,
  IsNotEmpty, IsUUID,
} from 'class-validator'
import { Transform } from 'class-transformer'
import { ApiProperty } from '@nestjs/swagger'

export class RegisterDto {
  @ApiProperty({ example: 'Ram Bahadur' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @IsNotEmpty() @MinLength(2) @MaxLength(100)
  name!: string

  @ApiProperty({ example: 'ram@example.com' })
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
  @Matches(/[A-Z]/, { message: 'Password must contain uppercase' })
  @Matches(/[0-9]/, { message: 'Password must contain a number' })
  password!: string
}

export class LoginDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  email!: string

  @IsString() @IsNotEmpty() @MaxLength(128)
  password!: string
}

export class ForgotPasswordDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  email!: string
}

export class ResetPasswordDto {
  @IsString() @MinLength(32) @MaxLength(256)
  token!: string

  @IsString() @MinLength(8) @MaxLength(64)
  @Matches(/[A-Z]/) @Matches(/[0-9]/)
  newPassword!: string
}

export class VerifyEmailDto {
  @IsString() @IsNotEmpty() @MinLength(6) @MaxLength(256)
  token!: string
}

// ── OTP Verification DTOs ────────────────────────────────────────────────────

export class VerifyOtpDto {
  @ApiProperty({ description: 'User ID', format: 'uuid' })
  @IsUUID('4')
  userId!: string

  @ApiProperty({ description: '6-digit OTP code', example: '123456' })
  @IsString() @IsNotEmpty()
  @Matches(/^\d{6,10}$/, { message: 'OTP must be 6-10 digits' })
  otp!: string
}

export class ResendOtpDto {
  @ApiProperty({ description: 'User ID', format: 'uuid' })
  @IsUUID('4')
  userId!: string

  @ApiProperty({ description: 'User email', example: 'user@example.com' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  email!: string
}

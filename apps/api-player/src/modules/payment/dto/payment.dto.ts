// CHANGED: [DTO hardening — @IsNotEmpty, @MaxLength on all fields]
// NEW ISSUES FOUND:
//   - EsewaVerifyDto.data had only MinLength(10) — no MaxLength, unbounded base64 blob accepted
//   - KhaltiVerifyDto.pidx had no @IsNotEmpty — empty string bypassed MinLength check

// apps/player-api/src/modules/payment/dto/payment.dto.ts
import {
  IsUUID, IsString, MinLength, MaxLength, IsNotEmpty,
} from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class KhaltiInitiateDto {
  @ApiProperty()
  @IsUUID('4')
  bookingId!: string
}

export class KhaltiVerifyDto {
  @ApiProperty({ minLength: 10, maxLength: 100 })
  @IsString() @IsNotEmpty() @MinLength(10) @MaxLength(100)
  pidx!: string

  @ApiProperty()
  @IsUUID('4')
  bookingId!: string
}

export class EsewaInitiateDto {
  @ApiProperty()
  @IsUUID('4')
  bookingId!: string
}

export class EsewaVerifyDto {
  @ApiProperty({ description: 'Base64-encoded eSewa response payload', minLength: 10, maxLength: 2048 })
  @IsString() @IsNotEmpty() @MinLength(10) @MaxLength(2048)
  data!: string
}
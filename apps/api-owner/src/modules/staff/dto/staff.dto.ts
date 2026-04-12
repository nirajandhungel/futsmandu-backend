import {
  IsEmail, IsString, IsNotEmpty, IsIn, IsOptional,
  MinLength, MaxLength,
} from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'

export class InviteStaffDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) name!: string
  @ApiProperty() @IsEmail() email!: string
  @ApiProperty() @IsString() @MinLength(10) @MaxLength(10) phone!: string
  @ApiProperty() @IsString() @MinLength(8) password!: string
  @ApiProperty({ enum: ['OWNER_ADMIN', 'OWNER_STAFF'] })
  @IsIn(['OWNER_ADMIN', 'OWNER_STAFF']) role!: string
}

export class UpdateStaffRoleDto {
  @ApiProperty({ enum: ['OWNER_ADMIN', 'OWNER_STAFF'] })
  @IsIn(['OWNER_ADMIN', 'OWNER_STAFF']) role!: string
}

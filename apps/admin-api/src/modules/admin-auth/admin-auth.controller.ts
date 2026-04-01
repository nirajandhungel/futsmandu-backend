import {
  Controller, Post, Body, HttpCode, HttpStatus, Req,
  UnauthorizedException,
} from '@nestjs/common'
import { ApiTags, ApiOperation } from '@nestjs/swagger'
import { IsString } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import type { FastifyRequest } from 'fastify'
import { AdminAuthService } from './admin-auth.service.js'
import { AdminLoginDto } from './dto/admin-auth.dto.js'
import { AdminPublic } from '../../common/guards/admin-jwt.guard.js'

class RefreshAdminDto {
  @ApiProperty() @IsString() refreshToken!: string
}

@ApiTags('Admin Auth')
@Controller('auth')
export class AdminAuthController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  @AdminPublic()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin login — returns 8h access token' })
  login(@Body() dto: AdminLoginDto) {
    return this.adminAuth.login(dto)
  }

  @AdminPublic()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh admin access token' })
  refresh(@Body() dto: RefreshAdminDto) {
    if (!dto.refreshToken) throw new UnauthorizedException('refreshToken required')
    return this.adminAuth.refresh(dto.refreshToken)
  }
}

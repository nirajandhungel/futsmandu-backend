import {
  Controller, Post, Body, Res, Req, HttpCode, HttpStatus,
  UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { OwnerAuthService } from './owner-auth.service.js'
import { RegisterOwnerDto, LoginOwnerDto, UploadDocDto, VerifyOtpDto, ResendOtpDto } from './dto/owner-auth.dto.js'
import { OwnerJwtGuard, Public } from '../../common/guards/owner-jwt.guard.js'
import { CurrentOwner } from '../../common/decorators/current-owner.decorator.js'
import type { AuthOwner } from '../../common/guards/owner-jwt.guard.js'
import { ENV } from '@futsmandu/utils'
import { MediaService } from '@futsmandu/media'

const REFRESH_COOKIE = 'owner_refresh'
const COOKIE_OPTS = {
  httpOnly: true,
  secure:   ENV['NODE_ENV'] === 'production',
  sameSite: 'strict' as const,
  path:     '/api/v1/owner/auth',
  maxAge:   30 * 24 * 60 * 60, // 30 days in seconds
}

@ApiTags('Owner Auth')
@Controller('auth')
export class OwnerAuthController {
  constructor(
    private readonly ownerAuth: OwnerAuthService,
    private readonly media: MediaService,
  ) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Register new owner account' })
  async register(@Body() dto: RegisterOwnerDto) {
    return this.ownerAuth.register(dto)
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login — returns access token + sets refresh cookie' })
  async login(@Body() dto: LoginOwnerDto, @Res({ passthrough: true }) res: FastifyReply) {
    const result = await this.ownerAuth.login(dto)
    void res.setCookie(REFRESH_COOKIE, result.refreshToken, COOKIE_OPTS)
    return { accessToken: result.accessToken, owner: result.owner }
  }

  @Public()
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify OTP and complete email verification' })
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.ownerAuth.verifyOtp(dto.ownerId, dto.otp)
  }

  @Public()
  @Post('resend-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resend OTP to email with rate limiting' })
  async resendOtp(@Body() dto: ResendOtpDto, @Req() req: FastifyRequest): Promise<{ success: boolean; message: string }> {
    const ip = req.ip
    const userAgent = req.headers['user-agent']
    return this.ownerAuth.resendOtp(dto.ownerId, ip, userAgent)
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate tokens via HTTP-only cookie' })
  async refresh(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const token = (req.cookies as Record<string, string>)[REFRESH_COOKIE]
    if (!token) throw new (await import('@nestjs/common')).UnauthorizedException('No refresh token cookie')
    const result = await this.ownerAuth.refresh(token)
    void res.setCookie(REFRESH_COOKIE, result.refreshToken, COOKIE_OPTS)
    return { accessToken: result.accessToken }
  }

  @UseGuards(OwnerJwtGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('Owner-JWT')
  @ApiOperation({ summary: 'Clear refresh cookie' })
  logout(@Res({ passthrough: true }) res: FastifyReply) {
    void res.clearCookie(REFRESH_COOKIE, { path: COOKIE_OPTS.path })
    return { message: 'Logged out' }
  }

  @UseGuards(OwnerJwtGuard)
  @Post('upload-docs')
  @ApiBearerAuth('Owner-JWT')
  @ApiOperation({
    summary: 'Get presigned R2 PUT URL for verification documents',
    description: 'Step 1 of unified media flow. After uploading the file, call POST /media/confirm-upload.',
  })
  uploadDocs(@CurrentOwner() owner: AuthOwner, @Body() dto: UploadDocDto) {
    return this.media.requestUploadUrl({
      assetType: 'kyc_document',
      ownerId: owner.id,
      entityId: owner.id,
      docType: dto.docType,
      contentType: dto.contentType,
    })
  }
}

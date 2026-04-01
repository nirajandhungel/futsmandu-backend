// CHANGED: [C-7 server-side Origin header check on /auth/refresh]
// NEW ISSUES FOUND:
//   - /auth/refresh had no origin validation — defence-in-depth gap despite SameSite=Strict cookie

// apps/player-api/src/modules/auth/auth.controller.ts
// Auth routes. All public (@Public bypasses global JwtAuthGuard).
// Refresh token delivered via HTTP-only cookie; access token in response body.
// C-7: /auth/refresh validates Origin header as defence-in-depth against CSRF.

import {
  Controller, Post, Body, Res, Req, HttpCode, HttpStatus,
  UnauthorizedException,
} from '@nestjs/common'
import { ApiTags, ApiOperation } from '@nestjs/swagger'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AuthService } from './auth.service.js'
import {
  RegisterDto, LoginDto, ForgotPasswordDto,
  ResetPasswordDto, VerifyEmailDto,
} from './dto/auth.dto.js'
import { Public } from '@futsmandu/auth'
import { ENV } from '@futsmandu/utils'

const COOKIE_OPTS = {
  httpOnly: true,
  secure: ENV['NODE_ENV'] === 'production',
  sameSite: 'strict' as const,
  path: '/api/v1/player/auth/refresh',
  maxAge: 7 * 24 * 60 * 60,
}

// C-7: Allowed origins for the refresh endpoint.
// In development, localhost variants are permitted.
const ALLOWED_ORIGINS = new Set<string>(
  ENV['NODE_ENV'] === 'production'
    ? [
        ENV['APP_URL'] ?? 'https://futsmandu.app',
        'https://futsmandu.app',
        'https://www.futsmandu.app',
      ]
    : [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://127.0.0.1:3000',
        // Allow undefined origin (e.g. Postman/curl in dev)
      ],
)

function validateRefreshOrigin(req: FastifyRequest): void {
  if (ENV['NODE_ENV'] !== 'production') return // skip in dev

  const origin = req.headers['origin']
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    throw new UnauthorizedException('Invalid request origin')
  }
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new player account' })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto)
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login and receive access + refresh tokens' })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.authService.login(dto)
    void reply.setCookie('refreshToken', result.refreshToken, COOKIE_OPTS)
    return { accessToken: result.accessToken, user: result.user }
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate tokens using HTTP-only refresh cookie' })
  async refresh(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    // C-7: Server-side Origin validation — defence-in-depth alongside SameSite=Strict
    validateRefreshOrigin(req)

    const token = (req.cookies as Record<string, string>)['refreshToken'] ?? ''
    const result = await this.authService.refresh(token)
    void reply.setCookie('refreshToken', result.refreshToken, COOKIE_OPTS)
    return { accessToken: result.accessToken }
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) reply: FastifyReply) {
    void reply.clearCookie('refreshToken', { path: COOKIE_OPTS.path })
    return { message: 'Logged out successfully' }
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email)
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.newPassword)
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto.token)
  }
}

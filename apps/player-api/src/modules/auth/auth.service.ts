// CHANGED: [C-2 refresh_token_version, H-6 password-reset token fingerprint, L-1 remove email from refresh JWT]
// NEW ISSUES FOUND:
//   - signRefresh embedded email: '' in JWT payload (L-1) — unnecessary field removed
//   - forgotPassword token had no password_hash fingerprint — reusable within 1h window (H-6)
//   - refresh() did not validate token version against DB — replay attack possible (C-2)

// apps/player-api/src/modules/auth/auth.service.ts
// Authentication service — registration, login, token rotation, password reset.
// Access token: 15m JWT in response body.
// Refresh token: 7d JWT in HTTP-only Secure cookie, rotated on every use.
// C-2: refresh_token_version embedded in refresh JWT; DB version checked on every rotation.
// H-6: Password reset token embeds last-8-chars of password_hash as fingerprint;
//      changing the password invalidates all outstanding reset tokens for that account.

import {
  Injectable, ConflictException, UnauthorizedException,
  ForbiddenException, Logger,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import * as bcrypt from 'bcryptjs'
import { PrismaService } from '@futsmandu/database'
import type { JwtPayload } from '@futsmandu/types'
import type { RegisterDto, LoginDto } from './dto/auth.dto.js'
import { ENV } from '@futsmandu/utils'

const DUMMY_HASH = '$2b$12$placeholder_hash_for_timing_safety_never_matches_any_pw'

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @InjectQueue('player-emails') private readonly emailQueue: Queue,
  ) {}

  // ── Register ──────────────────────────────────────────────────────────────
  async register(dto: RegisterDto) {
    const existing = await this.prisma.users.findFirst({
      where: { OR: [{ email: dto.email }, { phone: dto.phone }] },
      select: { email: true, phone: true },
    })

    if (existing) {
      const field = existing.email === dto.email ? 'email' : 'phone'
      throw new ConflictException(`An account with this ${field} already exists`)
    }

    const password_hash = await bcrypt.hash(dto.password, 12)

    const user = await this.prisma.users.create({
      data: { name: dto.name, email: dto.email, phone: dto.phone, password_hash },
      select: { id: true, name: true, email: true, phone: true, created_at: true },
    })

    await this.emailQueue
      .add(
        'verification-email',
        { type: 'verification-email', to: user.email, name: user.name, data: { userId: user.id } },
        { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 100, removeOnFail: 200 },
      )
      .catch((e: unknown) => this.logger.error('Failed to enqueue verification email', e))

    return user
  }

  // ── Login ─────────────────────────────────────────────────────────────────
  async login(dto: LoginDto) {
    const user = await this.prisma.users.findUnique({
      where: { email: dto.email },
      select: {
        id: true, name: true, email: true, phone: true, password_hash: true,
        is_active: true, is_verified: true, reliability_score: true,
        elo_rating: true, profile_image_url: true, ban_until: true,
        refresh_token_version: true,
      },
    })

    const validPassword = user
      ? await bcrypt.compare(dto.password, user.password_hash)
      : await bcrypt.compare(dto.password, DUMMY_HASH)

    if (!user || !validPassword) throw new UnauthorizedException('Invalid email or password')
    if (!user.is_active) throw new ForbiddenException('Account deactivated')

    const { password_hash: _pw, refresh_token_version: _rtv, ...safeUser } = user
    return {
      accessToken:  this.signAccess(user.id, user.email),
      refreshToken: this.signRefresh(user.id, user.refresh_token_version),
      user: safeUser,
    }
  }

  // ── Refresh ───────────────────────────────────────────────────────────────
  // C-2: Version check prevents replay of rotated tokens.
  async refresh(refreshToken: string) {
    let payload: JwtPayload & { rtv?: number }
    try {
      payload = this.jwt.verify<JwtPayload & { rtv?: number }>(refreshToken, {
        secret: ENV['PLAYER_JWT_SECRET'],
      })
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token')
    }

    if (payload.type !== 'refresh') throw new UnauthorizedException('Invalid token type')

    const user = await this.prisma.users.findUnique({
      where: { id: payload.sub, is_active: true },
      select: { id: true, email: true, refresh_token_version: true },
    })
    if (!user) throw new UnauthorizedException('User not found')

    // C-2: Version mismatch means this token was already rotated — reject immediately
    if ((payload.rtv ?? 0) !== user.refresh_token_version) {
      throw new UnauthorizedException('Refresh token already used — please log in again')
    }

    // Atomically increment version and return new tokens
    const updated = await this.prisma.users.update({
      where: { id: user.id },
      data: { refresh_token_version: { increment: 1 } },
      select: { refresh_token_version: true },
    })

    return {
      accessToken:  this.signAccess(user.id, user.email),
      refreshToken: this.signRefresh(user.id, updated.refresh_token_version),
    }
  }

  // ── Forgot Password ───────────────────────────────────────────────────────
  async forgotPassword(email: string) {
    const user = await this.prisma.users.findUnique({
      where: { email },
      select: { id: true, name: true, password_hash: true },
    })
    // Always return success — never reveal whether email exists
    if (user) {
      // H-6: Embed last 8 chars of current password_hash as fingerprint.
      // After the user resets their password, the hash changes → old token invalid.
      const pwFingerprint = user.password_hash.slice(-8)
      const token = this.jwt.sign(
        { sub: user.id, type: 'password-reset', pwf: pwFingerprint } satisfies Partial<JwtPayload> & { pwf: string },
        { expiresIn: '1h', secret: ENV['PLAYER_JWT_SECRET'] },
      )
      await this.emailQueue
        .add(
          'password-reset',
          { type: 'password-reset', to: email, name: user.name, data: { userId: user.id, token } },
          { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 100, removeOnFail: 200 },
        )
        .catch((e: unknown) => this.logger.error('Failed to enqueue password reset', e))
    }
    return { message: 'If this email is registered, a reset link has been sent' }
  }

  // ── Reset Password ────────────────────────────────────────────────────────
  async resetPassword(token: string, newPassword: string) {
    let payload: JwtPayload & { pwf?: string }
    try {
      payload = this.jwt.verify<JwtPayload & { pwf?: string }>(token, {
        secret: ENV['PLAYER_JWT_SECRET'],
      })
    } catch {
      throw new UnauthorizedException('Invalid or expired reset token')
    }
    if (payload.type !== 'password-reset') throw new UnauthorizedException('Invalid token type')

    // H-6: Verify fingerprint still matches current hash
    const user = await this.prisma.users.findUnique({
      where: { id: payload.sub },
      select: { password_hash: true },
    })
    if (!user) throw new UnauthorizedException('User not found')

    if (payload.pwf && user.password_hash.slice(-8) !== payload.pwf) {
      throw new UnauthorizedException('Reset token already used — request a new one')
    }

    const password_hash = await bcrypt.hash(newPassword, 12)
    // Also bump refresh_token_version so all active sessions are invalidated
    await this.prisma.users.update({
      where: { id: payload.sub },
      data: {
        password_hash,
        refresh_token_version: { increment: 1 },
        updated_at: new Date(),
      },
    })
    return { message: 'Password reset successfully. Please log in.' }
  }

  // ── Verify Email ──────────────────────────────────────────────────────────
  async verifyEmail(token: string) {
    let payload: JwtPayload
    try {
      payload = this.jwt.verify<JwtPayload>(token, { secret: ENV['PLAYER_JWT_SECRET'] })
    } catch {
      throw new UnauthorizedException('Invalid or expired verification token')
    }
    if (payload.type !== 'email-verify') throw new UnauthorizedException('Invalid token type')

    await this.prisma.users.update({
      where: { id: payload.sub },
      data: { is_verified: true, updated_at: new Date() },
    })
    return { message: 'Email verified. You can now book slots.' }
  }

  // ── Token helpers ─────────────────────────────────────────────────────────
  private signAccess(sub: string, email: string): string {
    return this.jwt.sign(
      { sub, email, type: 'access' } satisfies Partial<JwtPayload>,
      { expiresIn: '15m', secret: ENV['PLAYER_JWT_SECRET'] },
    )
  }

  // L-1: email removed from refresh payload — not needed and leaks PII in cookie
  // C-2: rtv (refresh token version) embedded so server can detect replayed tokens
  private signRefresh(sub: string, version: number): string {
    return this.jwt.sign(
      { sub, type: 'refresh', rtv: version } as Partial<JwtPayload> & { rtv: number },
      { expiresIn: '7d', secret: ENV['PLAYER_JWT_SECRET'] },
    )
  }
}

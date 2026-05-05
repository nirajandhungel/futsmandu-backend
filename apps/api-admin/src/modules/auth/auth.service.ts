// Admin authentication — completely separate JWT stack using ADMIN_JWT_SECRET.
// Admin accounts are stored in the dedicated `admins` table (separate from owners).
// 8-hour sessions for dashboard use. 2FA placeholder ready for TOTP integration.
import {
  Injectable, UnauthorizedException, ForbiddenException, Logger,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import bcrypt from 'bcryptjs'
import { PrismaService } from '@futsmandu/database'
import { OtpService } from '@futsmandu/auth'
import { AuditService } from '@futsmandu/audit'
import type { AdminLoginDto } from './dto/admin-auth.dto.js'
import { ENV } from '@futsmandu/utils'

// Cost-10 hash of 'dummy_password' — keeps timing consistent for non-existent accounts
const DUMMY_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'

interface AdminJwtPayload {
  sub:   string
  email: string
  type:  'access' | 'refresh'
  role:  string
  iat?:  number
  exp?:  number
}

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name)

  constructor(
    private readonly prisma:     PrismaService,
    private readonly jwt:        JwtService,
    private readonly otpService: OtpService,
    private readonly audit:      AuditService,
  ) {}

  async login(dto: AdminLoginDto) {
    const admin = await this.prisma.admins.findUnique({
      where: { email: dto.email },
      select: {
        id: true,
        name: true,
        email: true,
        password_hash: true,
        is_active: true,
        is_verified: true,
        role: true,
      },
    })

    // Constant-time compare — prevents email enumeration
    const valid = admin
      ? await bcrypt.compare(dto.password, admin.password_hash)
      : await bcrypt.compare(dto.password, DUMMY_HASH)

    if (!admin || !valid) throw new UnauthorizedException('Invalid credentials')
    if (!admin.is_active) throw new ForbiddenException('Account deactivated')
    if (!admin.is_verified) throw new ForbiddenException('Please verify your email first before logging in')

    const adminRole = admin?.role
    if (!adminRole || !['ADMIN', 'SUPER_ADMIN'].includes(adminRole)) {
      throw new ForbiddenException('Not an admin account')
    }

    // 2FA — verify email OTP code in production
    if (ENV['NODE_ENV'] === 'production') {
      if (!dto.totpCode) {
        throw new UnauthorizedException('2FA code (OTP) required in production')
      }
      const otpValid = await this.otpService.verifyOtp(admin.id, 'admin', dto.totpCode)
      if (!otpValid.success) {
        throw new UnauthorizedException(otpValid.message || 'Invalid 2FA code')
      }
    }



    return {
      accessToken: this.signAdminAccess(admin.id, admin.email, adminRole),
      admin: {
        id:   admin.id,
        name: admin.name,
        email: admin.email,
        role: adminRole,
      },
    }
  }

  async refresh(refreshToken: string) {
    let payload: AdminJwtPayload
    try {
      payload = this.jwt.verify<AdminJwtPayload>(refreshToken, {
        secret: ENV['ADMIN_JWT_SECRET'],
      })
    } catch {
      throw new UnauthorizedException('Invalid or expired admin refresh token')
    }
    if (payload.type !== 'refresh') throw new UnauthorizedException('Invalid token type')

    const admin = await this.prisma.admins.findUnique({
      where: { id: payload.sub, is_active: true },
      select: { id: true, email: true, role: true },
    })
    if (!admin) throw new UnauthorizedException('Admin not found')
    const adminRole = admin.role

    return {
      accessToken: this.signAdminAccess(admin.id, admin.email, adminRole),
    }
  }

  // ── Verify OTP ────────────────────────────────────────────────────────────
  // Verify OTP for admin email verification
  async verifyOtp(adminId: string, otp: string) {
    return this.otpService.verifyOtp(adminId, 'admin', otp)
  }

  // ── Resend OTP ────────────────────────────────────────────────────────────
  // Resend OTP with rate limiting
  async resendOtp(adminId: string, ipAddress?: string, userAgent?: string): Promise<{ success: boolean; message: string }> {
    return this.otpService.resendOtp(adminId, 'admin', ipAddress, userAgent)
  }

  // Admin sessions: 8h access tokens for dashboard use
  private signAdminAccess(sub: string, email: string, role: string): string {
    return this.jwt.sign(
      { sub, email, type: 'access' as const, role },
      { expiresIn: '8h', secret: ENV['ADMIN_JWT_SECRET'] },
    )
  }
}

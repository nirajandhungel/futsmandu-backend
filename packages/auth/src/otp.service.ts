// packages/auth/src/otp.service.ts
// OTP generation, validation, and resend logic.
// Shared across player, owner, and admin auth modules.
//
// PERF: Email is now fire-and-forget via BullMQ — generateOtp() no longer
//       calls Resend directly, so registration stays under ~100ms.
//       Each app (player-api, owner-api) injects its own queue under the
//       OTP_EMAIL_QUEUE token.  If no queue is injected (e.g. tests / admin
//       REPL) the service logs a warning and skips the enqueue step.

import { Injectable, BadRequestException, Logger, Inject, Optional } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PrismaService } from '@futsmandu/database'
import { ENV } from '@futsmandu/utils'

// ── Injection token ────────────────────────────────────────────────────────
// Each app provides its own queue under this token:
//
//   { provide: OTP_EMAIL_QUEUE, useExisting: getQueueToken('player-emails') }
//   { provide: OTP_EMAIL_QUEUE, useExisting: getQueueToken('owner-emails') }
//
export const OTP_EMAIL_QUEUE = 'OTP_EMAIL_QUEUE'

export interface GenerateOtpResult {
  otp_id: string
  expires_at: Date
  /** Populated only in development — never sent to clients in production. */
  otp?: string
}

export interface VerifyOtpResult {
  success: boolean
  message: string
  verified_at?: Date
}

export interface ResendOtpResult {
  success: boolean
  message: string
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name)
  private readonly otpExpiryMinutes: number
  private readonly otpMaxAttempts: number
  private readonly otpLength: number

  constructor(
    private readonly prisma: PrismaService,
    // Optional: tests and the admin module may not wire up a queue.
    @Optional() @Inject(OTP_EMAIL_QUEUE) private readonly emailQueue: Queue | null,
  ) {
    this.otpExpiryMinutes = ENV.OTP_EXPIRY_MINUTES
    this.otpMaxAttempts   = ENV.OTP_MAX_ATTEMPTS
    this.otpLength        = ENV.OTP_LENGTH
  }

  // ── Generate OTP ──────────────────────────────────────────────────────────
  // Fast path: only DB writes + one queue push (~10–30 ms total).
  // Resend is called asynchronously by the worker — never inline here.
  async generateOtp(
    userId:    string,
    userType:  'player' | 'owner' | 'admin',
    email:     string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<GenerateOtpResult> {
    const userIdField = this.userIdField(userType)

    // 1. Invalidate all previous unverified OTPs for this user
    await this.prisma.email_verification_otps.updateMany({
      where:  { verified_at: null, [userIdField]: userId },
      data:   { expires_at: new Date() },
    })

    // 2. Generate OTP + store in DB
    const otp       = this.generateRandomOtp()
    const dbUserType = userType === 'player' ? 'USER' : userType === 'owner' ? 'OWNER' : 'ADMIN'

    const otpRecord = await this.prisma.email_verification_otps.create({
      data: {
        user_type:    dbUserType,
        [userIdField]: userId,
        email,
        otp,
        ip_address:   ipAddress,
        user_agent:   userAgent,
        expires_at:   new Date(Date.now() + this.otpExpiryMinutes * 60 * 1_000),
        max_attempts: this.otpMaxAttempts,
      },
    })

    // 3. Enqueue email — fire-and-forget (never await the Resend call here)
    if (this.emailQueue) {
      await this.emailQueue
        .add(
          'otp-verification',
          { type: 'otp-verification', to: email, data: { otp, userType } },
          { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 50, removeOnFail: 100 },
        )
        .catch((err: unknown) =>
          this.logger.error(`Failed to enqueue OTP email for ${userType} ${userId}`, err),
        )
    } else {
      this.logger.warn(`No OTP_EMAIL_QUEUE injected — email skipped for ${userType} ${userId}`)
    }

    if (ENV.NODE_ENV === 'development') {
      this.logger.debug(`Dev OTP for ${userType} ${userId}: ${otp}`)
    }

    return {
      otp_id:     otpRecord.id,
      expires_at: otpRecord.expires_at,
      ...(ENV.NODE_ENV === 'development' ? { otp } : {}),
    }
  }

  // ── Verify OTP ────────────────────────────────────────────────────────────
  async verifyOtp(
    userId:     string,
    userType:   'player' | 'owner' | 'admin',
    otp:        string,
    ipAddress?: string,
  ): Promise<VerifyOtpResult> {
    const userIdField = this.userIdField(userType)

    const otpRecord = await this.prisma.email_verification_otps.findFirst({
      where: {
        [userIdField]: userId,
        verified_at:   null,
        expires_at:    { gt: new Date() },
      },
      orderBy: { created_at: 'desc' },
    })

    if (!otpRecord) {
      return { success: false, message: 'Invalid or expired OTP' }
    }

    // Already exhausted attempts — expire and bail
    if (otpRecord.attempts >= otpRecord.max_attempts) {
      await this.prisma.email_verification_otps.update({
        where: { id: otpRecord.id },
        data:  { expires_at: new Date() },
      })
      return { success: false, message: 'Invalid or expired OTP' }
    }

    // Increment attempt counter first (prevents race-condition double-spend)
    const updated = await this.prisma.email_verification_otps.update({
      where: { id: otpRecord.id },
      data:  { attempts: { increment: 1 } },
    })

    if (!this.constantTimeCompare(otp, otpRecord.otp)) {
      // If this was the last allowed attempt, expire immediately
      if (updated.attempts >= updated.max_attempts) {
        await this.prisma.email_verification_otps.update({
          where: { id: otpRecord.id },
          data:  { expires_at: new Date() },
        })
      }
      return { success: false, message: 'Invalid or expired OTP' }
    }

    // Mark OTP verified + flip is_verified on the user row — single transaction
    const [verified] = await this.prisma.$transaction([
      this.prisma.email_verification_otps.update({
        where: { id: otpRecord.id },
        data:  { verified_at: new Date() },
      }),
      ...(userType === 'player'
        ? [this.prisma.users.update({  where: { id: userId }, data: { is_verified: true } })]
        : userType === 'owner'
          ? [this.prisma.owners.update({ where: { id: userId }, data: { is_verified: true } })]
          : [this.prisma.admins.update({ where: { id: userId }, data: { is_verified: true } })]),
    ])

    this.logger.log(`OTP verified for ${userType} ${userId}`)
    return {
      success:     true,
      message:     'Email verified successfully!',
      verified_at: verified.verified_at ?? undefined,
    }
  }

  // ── Resend OTP ────────────────────────────────────────────────────────────
  async resendOtp(
    userId:     string,
    userType:   'player' | 'owner' | 'admin',
    ipAddress?: string,
    userAgent?: string,
  ): Promise<ResendOtpResult> {
    const user = await this.findUserEmail(userId, userType)

    if (!user?.email || user.is_verified) {
      throw new BadRequestException('Unable to resend OTP')
    }

    // Rate-limit: max 3 OTP requests per hour
    const recentCount = await this.prisma.email_verification_otps.count({
      where: {
        [this.userIdField(userType)]: userId,
        created_at: { gt: new Date(Date.now() - 60 * 60 * 1_000) },
      },
    })

    if (recentCount >= 3) {
      throw new BadRequestException('Too many resend requests. Please wait before trying again.')
    }

    await this.generateOtp(userId, userType, user.email, ipAddress, userAgent)

    return { success: true, message: 'A new OTP has been sent to your registered email.' }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private userIdField(userType: 'player' | 'owner' | 'admin'): string {
    return userType === 'player' ? 'player_id' : userType === 'owner' ? 'owner_id' : 'admin_id'
  }

  private async findUserEmail(
    userId:   string,
    userType: 'player' | 'owner' | 'admin',
  ): Promise<{ email: string; is_verified: boolean } | null> {
    if (userType === 'player')
      return this.prisma.users.findUnique({  where: { id: userId }, select: { email: true, is_verified: true } })
    if (userType === 'owner')
      return this.prisma.owners.findUnique({ where: { id: userId }, select: { email: true, is_verified: true } })
    return this.prisma.admins.findUnique({   where: { id: userId }, select: { email: true, is_verified: true } })
  }

  private generateRandomOtp(): string {
    const max    = Math.pow(10, this.otpLength) - 1
    const random = Math.floor(Math.random() * (max + 1))
    return String(random).padStart(this.otpLength, '0')
  }

  private constantTimeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let result = 0
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i)
    }
    return result === 0
  }
}
// packages/auth/src/otp.service.ts

import {
  Injectable,
  BadRequestException,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PrismaService } from '@futsmandu/database'
import type { Prisma } from '@futsmandu/database'
import { ENV } from '@futsmandu/utils'
import { randomInt, createHash } from 'crypto'

export const OTP_EMAIL_QUEUE = 'OTP_EMAIL_QUEUE'

export interface GenerateOtpResult {
  otp_id: string
  expires_at: Date
  otp?: string // dev only
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

  private readonly otpExpiryMinutes = ENV.OTP_EXPIRY_MINUTES
  private readonly otpMaxAttempts = ENV.OTP_MAX_ATTEMPTS
  private readonly otpLength = ENV.OTP_LENGTH
  private readonly otpSecret = ENV.OTP_SECRET ?? 'fallback-secret'

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(OTP_EMAIL_QUEUE) private readonly emailQueue: Queue | null,
  ) {}

  // ─────────────────────────────────────────────
  // HASH HELPERS
  // ─────────────────────────────────────────────
  private hashOtp(otp: string): string {
    return createHash('sha256')
      .update(`${otp}.${this.otpSecret}`)
      .digest('hex')
  }

  private generateRandomOtp(): string {
    const max = Math.pow(10, this.otpLength)
    return String(randomInt(0, max)).padStart(this.otpLength, '0')
  }

  private userIdField(userType: 'player' | 'owner' | 'admin'): string {
    return userType === 'player'
      ? 'player_id'
      : userType === 'owner'
      ? 'owner_id'
      : 'admin_id'
  }

  // ─────────────────────────────────────────────
  // CREATE OTP (FAST + SAFE)
  // ─────────────────────────────────────────────
  async createOtpRecord(
    db: Prisma.TransactionClient | PrismaService,
    userId: string,
    userType: 'player' | 'owner' | 'admin',
    email: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const userIdField = this.userIdField(userType)
    const otp = this.generateRandomOtp()
    const otpHash = this.hashOtp(otp)

    const expires_at = new Date(Date.now() + this.otpExpiryMinutes * 60_000)

    const dbUserType =
      userType === 'player' ? 'USER' : userType === 'owner' ? 'OWNER' : 'ADMIN'

    const execute = async (tx: Prisma.TransactionClient) => {
      // 🚀 delete old active OTP (safe inside transaction)
      await tx.email_verification_otps.deleteMany({
        where: {
          [userIdField]: userId,
          verified_at: null,
        },
      })

      const created = await tx.email_verification_otps.create({
        data: {
          user_type: dbUserType as any,
          [userIdField]: userId,
          email,
          otp: otpHash,
          expires_at,
          max_attempts: this.otpMaxAttempts,
          ip_address: ipAddress,
          user_agent: userAgent,
        },
        select: {
          id: true,
          expires_at: true,
        },
      })

      return {
        otp_id: created.id,
        expires_at: created.expires_at,
        otp,
      }
    }

    if ('$transaction' in db) {
      return (db as PrismaService).$transaction(execute)
    }
    return execute(db as Prisma.TransactionClient)
  }

  // ─────────────────────────────────────────────
  // QUEUE EMAIL (FIRE AND FORGET)
  // ─────────────────────────────────────────────
  enqueueOtpEmail(params: {
    userId: string
    userType: 'player' | 'owner' | 'admin'
    email: string
    otp: string
  }) {
    if (!this.emailQueue) {
      this.logger.warn(
        `OTP queue missing → skipped email for ${params.userType}:${params.userId}`,
      )
      return
    }

    void this.emailQueue
      .add(
        'otp-verification',
        {
          type: 'otp-verification',
          to: params.email,
          data: {
            otp: params.otp,
            userType: params.userType,
          },
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 50,
          removeOnFail: 100,
        },
      )
      .catch((err) =>
        this.logger.error('OTP queue error', err as any),
      )
  }

  // ─────────────────────────────────────────────
  // GENERATE OTP
  // ─────────────────────────────────────────────
  async generateOtp(
    userId: string,
    userType: 'player' | 'owner' | 'admin',
    email: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<GenerateOtpResult> {
    const created = await this.createOtpRecord(
      this.prisma,
      userId,
      userType,
      email,
      ipAddress,
      userAgent,
    )

    this.enqueueOtpEmail({
      userId,
      userType,
      email,
      otp: created.otp,
    })

    return {
      otp_id: created.otp_id,
      expires_at: created.expires_at,
      ...(ENV.NODE_ENV === 'development' ? { otp: created.otp } : {}),
    }
  }

  // ─────────────────────────────────────────────
  // VERIFY OTP (HASH COMPARE)
  // ─────────────────────────────────────────────
  async verifyOtp(
    userId: string,
    userType: 'player' | 'owner' | 'admin',
    otp: string,
  ): Promise<VerifyOtpResult> {
    const userIdField = this.userIdField(userType)
    const now = new Date()

    const record = await this.prisma.email_verification_otps.findFirst({
      where: {
        [userIdField]: userId,
        verified_at: null,
        expires_at: { gt: now },
      },
      select: {
        id: true,
        otp: true,
        attempts: true,
        max_attempts: true,
      },
    })

    if (!record) {
      return { success: false, message: 'Invalid or expired OTP' }
    }

    if (record.attempts >= record.max_attempts) {
      return { success: false, message: 'Too many attempts' }
    }

    const isValid =
      this.hashOtp(otp) === record.otp

    if (!isValid) {
      await this.prisma.email_verification_otps.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      })

      return { success: false, message: 'Invalid OTP' }
    }

    const now2 = new Date()

    await Promise.all([
      this.prisma.email_verification_otps.update({
        where: { id: record.id },
        data: { verified_at: now2 },
      }),
      this.updateUserVerified(userType, userId),
    ])

    return {
      success: true,
      message: 'Email verified successfully',
      verified_at: now2,
    }
  }

  // ─────────────────────────────────────────────
  // RESEND OTP (SAFE RATE LIMIT)
  // ─────────────────────────────────────────────
  async resendOtp(
    userId: string,
    userType: 'player' | 'owner' | 'admin',
    ipAddress?: string,
    userAgent?: string,
  ): Promise<ResendOtpResult> {
    const user = await this.findUserEmail(userId, userType)

    if (!user?.email || user.is_verified) {
      throw new BadRequestException('Unable to resend OTP')
    }

    const cutoff = new Date(Date.now() - 60 * 60 * 1000)

    const recent = await this.prisma.email_verification_otps.findFirst({
      where: {
        [this.userIdField(userType)]: userId,
        created_at: { gt: cutoff },
      },
      select: { id: true },
    })

    if (recent) {
      throw new BadRequestException('Too many resend requests')
    }

    await this.generateOtp(
      userId,
      userType,
      user.email,
      ipAddress,
      userAgent,
    )

    return {
      success: true,
      message: 'OTP sent successfully',
    }
  }

  // ─────────────────────────────────────────────
  // USER UPDATE
  // ─────────────────────────────────────────────
  private updateUserVerified(
    userType: 'player' | 'owner' | 'admin',
    userId: string,
  ) {
    if (userType === 'player') {
      return this.prisma.users.update({
        where: { id: userId },
        data: { is_verified: true },
      })
    }

    if (userType === 'owner') {
      return this.prisma.owners.update({
        where: { id: userId },
        data: { is_verified: true },
      })
    }

    return this.prisma.admins.update({
      where: { id: userId },
      data: { is_verified: true },
    })
  }

  // ─────────────────────────────────────────────
  // USER LOOKUP
  // ─────────────────────────────────────────────
  private async findUserEmail(
    userId: string,
    userType: 'player' | 'owner' | 'admin',
  ) {
    if (userType === 'player') {
      return this.prisma.users.findUnique({
        where: { id: userId },
        select: { email: true, is_verified: true },
      })
    }

    if (userType === 'owner') {
      return this.prisma.owners.findUnique({
        where: { id: userId },
        select: { email: true, is_verified: true },
      })
    }

    return this.prisma.admins.findUnique({
      where: { id: userId },
      select: { email: true, is_verified: true },
    })
  }
}
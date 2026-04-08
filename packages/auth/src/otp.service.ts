// packages/auth/src/otp.service.ts
// OTP generation, validation, and email sending for email verification.
// Shared across player, owner, and admin auth modules.
// OTPs expire after 10 minutes and allow max 5 verification attempts.

import { Injectable, BadRequestException, Logger } from '@nestjs/common'
import { Resend } from 'resend'
import { PrismaService } from '@futsmandu/database'
import { ENV } from '@futsmandu/utils'

export interface GenerateOtpResult {
  otp_id: string
  expires_at: Date
  otp: string // Only in dev mode, never in production
}

export interface VerifyOtpResult {
  success: boolean
  message: string
  verified_at?: Date
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name)
  private readonly resend: Resend
  private readonly otpExpiryMinutes: number
  private readonly otpMaxAttempts: number
  private readonly otpLength: number

  constructor(private readonly prisma: PrismaService) {
    this.resend = new Resend(ENV.RESEND_API_KEY)
    this.otpExpiryMinutes = ENV.OTP_EXPIRY_MINUTES
    this.otpMaxAttempts = ENV.OTP_MAX_ATTEMPTS
    this.otpLength = ENV.OTP_LENGTH
  }

  // ── Generate OTP ──────────────────────────────────────────────────────────
  async generateOtp(
    userId: string,
    userType: 'player' | 'owner' | 'admin',
    email: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<GenerateOtpResult> {
    try {
      // Invalidate any previous unverified OTPs for this user
      await this.prisma.email_verification_otps.updateMany({
        where: {
          verified_at: null,
          [userType === 'player' ? 'player_id' : userType === 'owner' ? 'owner_id' : 'admin_id']: userId,
        },
        data: { expires_at: new Date() }, // Expire immediately
      })

      // Generate random OTP
      const otp = this.generateRandomOtp()

      // Create OTP record in database
      const otpRecord = await this.prisma.email_verification_otps.create({
        data: {
          user_type: userType,
          [userType === 'player' ? 'player_id' : userType === 'owner' ? 'owner_id' : 'admin_id']: userId,
          email,
          otp,
          ip_address: ipAddress,
          user_agent: userAgent,
          expires_at: new Date(Date.now() + this.otpExpiryMinutes * 60 * 1000),
          max_attempts: this.otpMaxAttempts,
        },
      })

      // Send OTP via email
      await this.sendOtpEmail(email, otp, userType)

      // Return result with OTP only in development
      const result: GenerateOtpResult = {
        otp_id: otpRecord.id,
        expires_at: otpRecord.expires_at,
        otp: ENV['NODE_ENV'] === 'development' ? otp : '', // Dev only
      }

      this.logger.debug(`OTP generated for ${userType} ${userId}`)
      return result
    } catch (err) {
      this.logger.error(`Failed to generate OTP for ${userType} ${userId}:`, err)
      throw err
    }
  }

  // ── Verify OTP ────────────────────────────────────────────────────────────
  async verifyOtp(
    userId: string,
    userType: 'player' | 'owner' | 'admin',
    otp: string,
    ipAddress?: string,
  ): Promise<VerifyOtpResult> {
    try {
      // Find the most recent active OTP for this user
      const otpRecord = await this.prisma.email_verification_otps.findFirst({
        where: {
          [userType === 'player' ? 'player_id' : userType === 'owner' ? 'owner_id' : 'admin_id']: userId,
          verified_at: null,
          expires_at: { gt: new Date() },
        },
        orderBy: { created_at: 'desc' },
      })

      // OTP not found or expired
      if (!otpRecord) {
        return {
          success: false,
          message: 'OTP expired or not found. Request a new one.',
        }
      }

      // Check attempt limit
      if (otpRecord.attempts >= otpRecord.max_attempts) {
        await this.prisma.email_verification_otps.update({
          where: { id: otpRecord.id },
          data: { expires_at: new Date() }, // Expire this OTP
        })
        return {
          success: false,
          message: 'Too many failed attempts. Request a new OTP.',
        }
      }

      // Increment attempt counter
      await this.prisma.email_verification_otps.update({
        where: { id: otpRecord.id },
        data: { attempts: { increment: 1 } },
      })

      // Verify OTP (constant-time comparison)
      const isValid = this.constantTimeCompare(otp, otpRecord.otp)

      if (!isValid) {
        return {
          success: false,
          message: `Invalid OTP. ${otpRecord.max_attempts - otpRecord.attempts} attempts remaining.`,
        }
      }

      // Mark OTP as verified
      const verified = await this.prisma.email_verification_otps.update({
        where: { id: otpRecord.id },
        data: { verified_at: new Date() },
      })

      // Update user's is_verified status based on user type
      if (userType === 'player') {
        await this.prisma.users.update({
          where: { id: userId },
          data: { is_verified: true },
        })
      } else if (userType === 'owner') {
        await this.prisma.owners.update({
          where: { id: userId },
          data: { is_verified: true },
        })
      } else if (userType === 'admin') {
        await this.prisma.admins.update({
          where: { id: userId },
          data: { is_verified: true },
        })
      }

      this.logger.log(`OTP verified for ${userType} ${userId}`)
      return {
        success: true,
        message: 'Email verified successfully!',
        verified_at: verified.verified_at || undefined,
      }
    } catch (err) {
      this.logger.error(`Failed to verify OTP for ${userType} ${userId}:`, err)
      throw err
    }
  }

  // ── Resend OTP ────────────────────────────────────────────────────────────
  async resendOtp(
    userId: string,
    userType: 'player' | 'owner' | 'admin',
    email: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<GenerateOtpResult> {
    try {
      // Check rate limit: max 3 resends per 5 minutes
      const recentOtps = await this.prisma.email_verification_otps.findMany({
        where: {
          [userType === 'player' ? 'player_id' : userType === 'owner' ? 'owner_id' : 'admin_id']: userId,
          created_at: { gt: new Date(Date.now() - 5 * 60 * 1000) }, // Last 5 minutes
        },
      })

      if (recentOtps.length >= 3) {
        throw new BadRequestException(
          'Too many resend requests. Please wait 5 minutes before trying again.',
        )
      }

      // Generate and send new OTP
      return this.generateOtp(userId, userType, email, ipAddress, userAgent)
    } catch (err) {
      this.logger.error(`Failed to resend OTP for ${userType} ${userId}:`, err)
      throw err
    }
  }

  // ── Check if user is verified ──────────────────────────────────────────────
  async isUserVerified(userId: string, userType: 'player' | 'owner' | 'admin'): Promise<boolean> {
    try {
      if (userType === 'player') {
        const user = await this.prisma.users.findUnique({
          where: { id: userId },
          select: { is_verified: true },
        })
        return user?.is_verified ?? false
      } else if (userType === 'owner') {
        const owner = await this.prisma.owners.findUnique({
          where: { id: userId },
          select: { is_verified: true },
        })
        return owner?.is_verified ?? false
      } else if (userType === 'admin') {
        const admin = await this.prisma.admins.findUnique({
          where: { id: userId },
          select: { is_verified: true },
        })
        return admin?.is_verified ?? false
      }
      return false
    } catch (err) {
      this.logger.error(`Failed to check verification status for ${userType} ${userId}:`, err)
      return false
    }
  }

  // ── Private Helper Methods ────────────────────────────────────────────────────

  private generateRandomOtp(): string {
    const max = Math.pow(10, this.otpLength) - 1
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

  private async sendOtpEmail(email: string, otp: string, userType: string): Promise<void> {
    try {
      const { error } = await this.resend.emails.send({
        from: 'noreply@mail.nirajandhungel.com.np',
        to: email,
        subject: 'Verify Your Futsmandu Account - OTP',
        html: this.getOtpEmailTemplate(otp, userType),
      })

      if (error) {
        this.logger.error('Resend API error:', error)
        throw error
      }

      this.logger.debug(`OTP email sent to ${email}`)
    } catch (err) {
      this.logger.error(`Failed to send OTP email to ${email}:`, err)
      throw err
    }
  }

  private getOtpEmailTemplate(otp: string, userType: string): string {
    const userTypeLabel =
      userType === 'player' ? 'Football' : userType === 'owner' ? 'Venue Management' : 'Admin'

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0; }
            .content { background: #f9f9f9; padding: 20px; border-radius: 0 0 8px 8px; }
            .otp-box { background: white; border: 2px solid #667eea; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0; }
            .otp-code { font-size: 32px; font-weight: bold; color: #667eea; letter-spacing: 5px; }
            .timer { color: #ff6b6b; font-weight: bold; }
            .footer { font-size: 12px; color: #888; text-align: center; margin-top: 20px; }
            .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 10px; margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Verify Your Email Address</h1>
              <p>Futsmandu ${userTypeLabel} Platform</p>
            </div>
            <div class="content">
              <p>Hi there,</p>
              <p>Welcome to Futsmandu! Please verify your email address to complete your registration and unlock all features.</p>
              
              <div class="otp-box">
                <p>Your verification code is:</p>
                <div class="otp-code">${otp}</div>
                <p>This code expires in <span class="timer">10 minutes</span></p>
              </div>

              <h3>How to use your verification code:</h3>
              <ol>
                <li>Copy the 6-digit code above</li>
                <li>Return to the verification page in the app</li>
                <li>Paste the code and click "Verify"</li>
              </ol>

              <div class="warning">
                <strong>⚠️ Security Notice:</strong> Never share this code with anyone. We will never ask you for this code outside of the app.
              </div>

              <p>Didn't request this verification? Please ignore this email. If you believe something is wrong with your account, contact our support team.</p>

              <hr style="margin: 30px 0;" />
              <p style="font-size: 12px; color: #999;">
                Best regards,<br>
                The Futsmandu Support Team<br>
                <a href="https://nirajandhungel.com.np" style="color: #667eea; text-decoration: none;">nirajandhungel.com.np</a>
              </p>
            </div>
            <div class="footer">
              <p>© ${new Date().getFullYear()} Futsmandu. All rights reserved.</p>
              <p>This is an automated email. Please do not reply.</p>
            </div>
          </div>
        </body>
      </html>
    `
  }
}

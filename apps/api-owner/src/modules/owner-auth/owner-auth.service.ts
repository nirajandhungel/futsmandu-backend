// Owner authentication — registration, login, token rotation.
// Access token: 15m JWT. Refresh token: 30d HTTP-only cookie (Flutter mobile).
// Timing-attack safe: constant-time bcrypt compare even for non-existent accounts.
import {
  Injectable, ConflictException, UnauthorizedException,
  ForbiddenException, Logger,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import bcrypt from 'bcryptjs'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { PrismaService } from '@futsmandu/database'
import type { Prisma } from '@futsmandu/database'
import type { JwtPayload } from '@futsmandu/types'
import type { RegisterOwnerDto, LoginOwnerDto } from './dto/owner-auth.dto.js'
import { OtpService } from '@futsmandu/auth'
import { ENV } from '@futsmandu/utils'

// Cost-10 hash of 'dummy_password' — keeps timing consistent for non-existent accounts
const DUMMY_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'

function conflictFieldFromPrismaUniqueError(err: unknown): 'email' | 'phone' | null {
  const anyErr = err as any
  if (anyErr?.code !== 'P2002') return null
  const target = anyErr?.meta?.target
  const fields: string[] =
    Array.isArray(target) ? target : typeof target === 'string' ? [target] : []
  if (fields.includes('email')) return 'email'
  if (fields.includes('phone')) return 'phone'
  return null
}

@Injectable()
export class OwnerAuthService {
  private readonly logger = new Logger(OwnerAuthService.name)

  // S3Client singleton — created once at module startup, not per request
  private readonly s3 = new S3Client({
    region:         ENV['S3_REGION'] || 'us-east-1',
    endpoint:       ENV['S3_ENDPOINT'],
    forcePathStyle: ENV['S3_FORCE_PATH_STYLE'] === 'true',
    credentials: {
      accessKeyId:     ENV['S3_ACCESS_KEY'],
      secretAccessKey: ENV['S3_SECRET_KEY'],
    },
  })

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly otpService: OtpService,
    @InjectQueue('owner-emails') private readonly emailQueue: Queue,
  ) {}

  // ── Register ──────────────────────────────────────────────────────────────
  async register(dto: RegisterOwnerDto) {
    const password_hash = await bcrypt.hash(dto.password, 10)

    const result = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      let owner: {
        id: string
        name: string
        email: string
        phone: string
        business_name: string | null
        created_at: Date
        is_verified: boolean
      }

      try {
        owner = await tx.owners.create({
          data: {
            name: dto.name,
            email: dto.email,
            phone: dto.phone,
            password_hash,
            business_name: dto.business_name,
            is_verified: false,
          },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            business_name: true,
            created_at: true,
            is_verified: true,
          },
        })
      } catch (err) {
        const field = conflictFieldFromPrismaUniqueError(err)
        if (field) throw new ConflictException(`An account with this ${field} already exists`)
        throw err
      }

      const otp = await this.otpService.createOtpRecord(
        tx,
        owner.id,
        'owner',
        owner.email,
      )

      return { owner, otp }
    })

    // Enqueue OTP email out of transaction — never block the request.
    this.otpService.enqueueOtpEmail({
      userId: result.owner.id,
      userType: 'owner',
      email: result.owner.email,
      otp: result.otp.otp,
    })

    return result.owner
  }

  // ── Login ─────────────────────────────────────────────────────────────────
  // Updated: Check is_verified before issuing tokens
  async login(dto: LoginOwnerDto) {
    const owner = await this.prisma.owners.findUnique({
      where: { email: dto.email },
      select: {
        id: true, name: true, email: true, phone: true, password_hash: true,
        business_name: true, is_verified: true, is_active: true,
      },
    })

    // Constant-time compare — prevents email enumeration via timing
    const validPassword = owner
      ? await bcrypt.compare(dto.password, owner.password_hash)
      : await bcrypt.compare(dto.password, DUMMY_HASH)

    if (!owner || !validPassword) {
      throw new UnauthorizedException('Invalid email or password')
    }
    if (!owner.is_active) {
      throw new ForbiddenException('Account deactivated. Contact support.')
    }
    if (!owner.is_verified) {
      throw new ForbiddenException('Please verify your email first before logging in')
    }

    const { password_hash: _pw, ...safeOwner } = owner
    return {
      accessToken:  this.signAccess(owner.id, owner.email, 'OWNER_ADMIN'),
      refreshToken: this.signRefresh(owner.id),
      owner: safeOwner,
    }
  }

  // ── Refresh ───────────────────────────────────────────────────────────────
  async refresh(refreshToken: string) {
    let payload: JwtPayload
    try {
      payload = this.jwt.verify<JwtPayload>(refreshToken, {
        secret: ENV['OWNER_JWT_SECRET'],
      })
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token')
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Invalid token type')
    }

    const owner = await this.prisma.owners.findUnique({
      where: { id: payload.sub, is_active: true },
      select: { id: true, email: true },
    })
    if (!owner) throw new UnauthorizedException('Owner not found')

    return {
      accessToken:  this.signAccess(owner.id, owner.email, 'OWNER_ADMIN'),
      refreshToken: this.signRefresh(owner.id),
    }
  }

  // ── Presigned R2 URL for verification documents ───────────────────────────
  async getPresignedDocUrl(
    ownerId: string,
    docType: string,
  ): Promise<{ uploadUrl: string; key: string }> {
    // s3 is a class-level singleton — no dynamic import or new S3Client per call
    const key = `verify/${ownerId}/${docType}.pdf`
    const cmd = new PutObjectCommand({
      Bucket:       ENV['S3_BUCKET'],
      Key:          key,
      ContentType:  'application/pdf',
      CacheControl: 'no-store, private',
    })

    // Run the presign + DB update in parallel to cut one extra round-trip
    const [uploadUrl] = await Promise.all([
      getSignedUrl(this.s3, cmd, { expiresIn: 600 }),
      (async () => {
        const current = await this.prisma.owners.findUnique({
          where:  { id: ownerId },
          select: { verification_docs: true },
        })
        const existingDocs: Prisma.InputJsonObject =
          current?.verification_docs && typeof current.verification_docs === 'object'
            ? (current.verification_docs as Prisma.InputJsonObject)
            : {}
        const updatedDocs: Prisma.InputJsonObject = {
          ...(existingDocs as Record<string, Prisma.InputJsonValue>),
          [docType]: key,
        }
        await this.prisma.owners.update({
          where: { id: ownerId },
          data:  { verification_docs: updatedDocs, updated_at: new Date() },
        })
      })(),
    ])

    return { uploadUrl, key }
  }

  // ── Verify OTP ────────────────────────────────────────────────────────────
  // Verify OTP and mark owner as email-verified
  async verifyOtp(ownerId: string, otp: string) {
    return this.otpService.verifyOtp(ownerId, 'owner', otp)
  }

  // ── Resend OTP ────────────────────────────────────────────────────────────
  // Resend OTP with rate limiting
  async resendOtp(ownerId: string, ipAddress?: string, userAgent?: string): Promise<{ success: boolean; message: string }> {
    return this.otpService.resendOtp(ownerId, 'owner', ipAddress, userAgent)
  }

  // ── Token helpers ─────────────────────────────────────────────────────────
  private signAccess(sub: string, email: string, role: string): string {
    return this.jwt.sign(
      { sub, email, type: 'access' as const, role },
      { expiresIn: '15m', secret: ENV['OWNER_JWT_SECRET'] },
    )
  }

  private signRefresh(sub: string): string {
    return this.jwt.sign(
      { sub, email: '', type: 'refresh' as const },
      { expiresIn: '30d', secret: ENV['OWNER_JWT_SECRET'] },
    )
  }
}
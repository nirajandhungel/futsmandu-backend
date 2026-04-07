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
import { PrismaService } from '@futsmandu/database'
import type { Prisma } from '@futsmandu/database'
import type { JwtPayload } from '@futsmandu/types'
import type { RegisterOwnerDto, LoginOwnerDto } from './dto/owner-auth.dto.js'
import { ENV } from '@futsmandu/utils'

const DUMMY_HASH = '$2b$12$placeholder_hash_for_timing_safety_never_matches_any_pw'

@Injectable()
export class OwnerAuthService {
  private readonly logger = new Logger(OwnerAuthService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @InjectQueue('owner-emails') private readonly emailQueue: Queue,
  ) {}

  // ── Register ──────────────────────────────────────────────────────────────
  async register(dto: RegisterOwnerDto) {
    const existing = await this.prisma.owners.findFirst({
      where: { OR: [{ email: dto.email }, { phone: dto.phone }] },
      select: { email: true, phone: true },
    })
    if (existing) {
      const field = existing.email === dto.email ? 'email' : 'phone'
      throw new ConflictException(`An owner account with this ${field} already exists`)
    }

    const password_hash = await bcrypt.hash(dto.password, 12)
    const owner = await this.prisma.owners.create({
      data: {
        name:          dto.name,
        email:         dto.email,
        phone:         dto.phone,
        password_hash,
        business_name: dto.business_name,
      },
      select: {
        id: true, name: true, email: true,
        phone: true, business_name: true, created_at: true,
      },
    })

    await this.emailQueue
      .add(
        'owner-welcome',
        { type: 'owner-welcome', to: owner.email, name: owner.name, data: { ownerId: owner.id } },
        { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 100, removeOnFail: 200 },
      )
      .catch((e: unknown) => this.logger.error('Failed to enqueue welcome email', e))

    return owner
  }

  // ── Login ─────────────────────────────────────────────────────────────────
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
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3')
    const { getSignedUrl }              = await import('@aws-sdk/s3-request-presigner')

    const s3 = new S3Client({
      region:   ENV['S3_REGION'] || 'us-east-1',
      endpoint: ENV['S3_ENDPOINT'],
      forcePathStyle: ENV['S3_FORCE_PATH_STYLE'] === 'true',
      credentials: {
        accessKeyId:     ENV['S3_ACCESS_KEY'],
        secretAccessKey: ENV['S3_SECRET_KEY'],
      },
    })

    const key = `verify/${ownerId}/${docType}.pdf`
    const cmd = new PutObjectCommand({
      Bucket:       ENV['S3_BUCKET'],
      Key:          key,
      ContentType:  'application/pdf',
      CacheControl: 'no-store, private',
    })

    const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 600 })

    // Record doc key in owner's verification_docs JSON field
    const current = await this.prisma.owners.findUnique({
      where: { id: ownerId },
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
      data: {
        verification_docs: updatedDocs,
        updated_at: new Date(),
      },
    })

    return { uploadUrl, key }
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

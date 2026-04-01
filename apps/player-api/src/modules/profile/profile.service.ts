// CHANGED: [L-6 lazy S3Client initialization instead of module-load-time instantiation]
// NEW ISSUES FOUND:
//   - S3Client instantiated at module load with process.env — crashes container at startup
//     if CF_ACCOUNT_ID is missing, even if the upload feature is never called

// apps/player-api/src/modules/profile/profile.service.ts
// L-6: S3Client created lazily inside getAvatarUploadUrl() so missing R2 env vars
//      do not crash the entire container — they only fail the specific upload call.

import { Injectable, NotFoundException, InternalServerErrorException } from '@nestjs/common'
import {
  IsBoolean, IsEnum, IsOptional, IsString,
  MaxLength, MinLength, IsArray,
} from 'class-validator'
import { Transform } from 'class-transformer'
import { PrismaService } from '@futsmandu/database'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { ENV } from '@futsmandu/utils'

export class UpdateProfileDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MinLength(2) @MaxLength(100) @IsOptional()
  name?: string

  @IsEnum(['beginner', 'intermediate', 'advanced']) @IsOptional()
  skill_level?: 'beginner' | 'intermediate' | 'advanced'

  @IsArray() @IsOptional()
  preferred_roles?: Array<'goalkeeper' | 'defender' | 'midfielder' | 'striker'>

  @IsBoolean() @IsOptional()
  show_match_history?: boolean
}

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async getOwn(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: {
        id: true, name: true, email: true, phone: true,
        profile_image_url: true, skill_level: true, elo_rating: true,
        reliability_score: true, total_no_shows: true, total_late_cancels: true,
        matches_played: true, matches_won: true, matches_lost: true, matches_draw: true,
        show_match_history: true, is_verified: true, ban_until: true, created_at: true,
        preferred_roles: { select: { role: true } },
      },
    })
    if (!user) throw new NotFoundException('User not found')
    return user
  }

  async getPublic(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId, is_active: true },
      select: {
        id: true, name: true, profile_image_url: true,
        skill_level: true, elo_rating: true, reliability_score: true,
        matches_played: true, matches_won: true, matches_lost: true, matches_draw: true,
        show_match_history: true, created_at: true,
        preferred_roles: { select: { role: true } },
      },
    })
    if (!user) throw new NotFoundException('User not found')

    if (!user.show_match_history) {
      const { matches_played: _mp, matches_won: _mw, matches_lost: _ml, matches_draw: _md, ...rest } = user
      return rest
    }
    return user
  }

  async update(userId: string, dto: UpdateProfileDto) {
    return this.prisma.$transaction(async (tx: any) => {
      if (dto.preferred_roles !== undefined) {
        await tx.user_preferred_roles.deleteMany({ where: { user_id: userId } })
        if (dto.preferred_roles.length > 0) {
          await tx.user_preferred_roles.createMany({
            data: dto.preferred_roles.map(role => ({ user_id: userId, role })),
          })
        }
      }
      return tx.users.update({
        where: { id: userId },
        data: {
          ...(dto.name              !== undefined ? { name:               dto.name }               : {}),
          ...(dto.skill_level       !== undefined ? { skill_level:        dto.skill_level }        : {}),
          ...(dto.show_match_history !== undefined ? { show_match_history: dto.show_match_history } : {}),
          updated_at: new Date(),
        },
        select: {
          id: true, name: true, skill_level: true,
          show_match_history: true, updated_at: true,
        },
      })
    })
  }

  // L-6: S3Client created lazily here so a missing CF_ACCOUNT_ID does not crash
  //      the container on startup — it only fails this specific endpoint.
  async getAvatarUploadUrl(userId: string) {
    const accountId      = ENV['CF_ACCOUNT_ID']
    const accessKeyId    = ENV['R2_ACCESS_KEY_ID']
    const secretAccessKey = ENV['R2_SECRET_ACCESS_KEY']
    const bucketName     = ENV['R2_BUCKET_NAME']
    const cdnBase        = ENV['R2_CDN_BASE_URL']

    if (!accountId || !accessKeyId || !secretAccessKey || !bucketName || !cdnBase) {
      throw new InternalServerErrorException(
        'R2 storage is not configured — contact platform support',
      )
    }

    // Lazy client: created per-invocation; no module-load-time env access
    const r2 = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    })

    const key = `avatars/${userId}.jpg`
    const cmd = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=3600',
    })
    const uploadUrl = await getSignedUrl(r2, cmd, { expiresIn: 600 })
    const cdnUrl    = `${cdnBase}/${key}`

    await this.prisma.users.update({
      where: { id: userId },
      data: { profile_image_url: cdnUrl, updated_at: new Date() },
    })

    return { uploadUrl, cdnUrl, instructions: 'PUT image to uploadUrl, then cdnUrl becomes active' }
  }
}

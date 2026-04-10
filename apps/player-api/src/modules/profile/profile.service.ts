// apps/player-api/src/modules/profile/profile.service.ts
// CHANGED: Removed all inline S3/R2 logic (getAvatarUploadUrl was duplicating owner-api).
// Now delegates to @futsmandu/media MediaService.

import { Injectable, NotFoundException } from '@nestjs/common'
import {
  IsBoolean, IsEnum, IsOptional, IsString,
  MaxLength, MinLength, IsArray,
} from 'class-validator'
import { Transform } from 'class-transformer'
import { PrismaService } from '@futsmandu/database'
import { MediaService } from '@futsmandu/media'

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,   // ← injected from @futsmandu/media
  ) {}

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
          ...(dto.name               !== undefined ? { name:               dto.name }               : {}),
          ...(dto.skill_level        !== undefined ? { skill_level:        dto.skill_level }        : {}),
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

  // ── Profile image upload ─────────────────────────────────────────────────
  // Delegates entirely to shared MediaService — no S3 code here.
  // Returns assetId + uploadUrl + key. Client PUTs to uploadUrl, then confirms with assetId + key.
  async getAvatarUploadUrl(userId: string) {
    return this.media.requestUploadUrl({
      assetType: 'player_profile',
      ownerId:   userId,
      entityId:  userId,
    })
  }

  async confirmAvatarUpload(userId: string, assetId: string, key: string) {
    const result = await this.media.confirmUpload({
      ownerId: userId,
      assetId,
      key,
      assetType: 'player_profile',
    })

    // After confirming, update the user's profile_image_url to the CDN URL.
    // We store the KEY, then derive the CDN URL dynamically.
    const cdnUrl = this.media.getCdnUrl(key)
    await this.prisma.users.update({
      where: { id: userId },
      data:  { profile_image_url: cdnUrl, updated_at: new Date() },
    })

    return result
  }
}
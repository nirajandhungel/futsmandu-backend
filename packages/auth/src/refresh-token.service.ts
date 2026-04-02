import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import { randomUUID } from 'crypto'
import { RedisService } from '@futsmandu/redis'

type RefreshJwtPayload = {
  sub: string
  type: 'refresh'
  email?: string
  jti: string
  iat?: number
  exp?: number
}

@Injectable()
export class RefreshTokenService {
  private readonly redisPrefix: string

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.redisPrefix = this.config.get<string>('REFRESH_TOKEN_REDIS_PREFIX') ?? 'refresh:'
  }

  private getRefreshSecret(): string {
    return (
      this.config.get<string>('REFRESH_JWT_SECRET') ??
      this.config.get<string>('PLAYER_JWT_SECRET') ??
      this.config.get<string>('OWNER_JWT_SECRET') ??
      this.config.get<string>('ADMIN_JWT_SECRET') ??
      ''
    )
  }

  private getDefaultTtlSeconds(): number {
    const raw =
      this.config.get<string>('REFRESH_TOKEN_TTL_SECONDS') ??
      this.config.get<string>('REFRESH_TOKEN_TTL_DAYS') ??
      '7'

    // If it looks like days, default to days; otherwise treat as seconds.
    const asNumber = Number.parseInt(raw, 10)
    if (Number.isNaN(asNumber) || asNumber <= 0) return 7 * 24 * 60 * 60

    if (this.config.get<string>('REFRESH_TOKEN_TTL_SECONDS')) return asNumber
    // TTL_DAYS
    return asNumber * 24 * 60 * 60
  }

  private keyFor(sub: string, jti: string): string {
    return `${this.redisPrefix}${sub}:${jti}`
  }

  async issueRefreshToken(params: {
    sub: string
    email?: string
    ttlSeconds?: number
  }): Promise<string> {
    const secret = this.getRefreshSecret()
    if (!secret) throw new InternalServerErrorException('Missing refresh JWT secret')

    const jti = randomUUID()
    const ttlSeconds = params.ttlSeconds ?? this.getDefaultTtlSeconds()

    const key = this.keyFor(params.sub, jti)
    // Cache operations are best-effort; fail closed if key cannot be set.
    await this.redis.set(key, '1', ttlSeconds).catch(() => undefined)

    const token = this.jwt.sign(
      {
        sub: params.sub,
        type: 'refresh',
        email: params.email ?? '',
        jti,
      } satisfies Partial<RefreshJwtPayload> & { jti: string },
      {
        expiresIn: ttlSeconds,
        secret,
      },
    )

    return token
  }

  async isRefreshTokenValid(params: { sub: string; jti: string }): Promise<boolean> {
    const key = this.keyFor(params.sub, params.jti)
    const val = await this.redis.get<string>(key)
    return val !== null
  }

  async rotateRefreshToken(params: {
    sub: string
    email?: string
    jti: string
    ttlSeconds?: number
  }): Promise<{ refreshToken: string }> {
    const valid = await this.isRefreshTokenValid({ sub: params.sub, jti: params.jti })
    if (!valid) {
      throw new UnauthorizedException('Refresh token already used or revoked')
    }

    const ttlSeconds = params.ttlSeconds ?? this.getDefaultTtlSeconds()

    // Best-effort revoke + set. If revoke fails, rotate still works because old key will
    // likely expire; but if set fails, token will fail next time and client can re-login.
    const oldKey = this.keyFor(params.sub, params.jti)
    await this.redis.del(oldKey).catch(() => undefined)

    const nextJti = randomUUID()
    const nextKey = this.keyFor(params.sub, nextJti)
    await this.redis.set(nextKey, '1', ttlSeconds).catch(() => undefined)

    const secret = this.getRefreshSecret()
    if (!secret) throw new InternalServerErrorException('Missing refresh JWT secret')

    const refreshToken = this.jwt.sign(
      {
        sub: params.sub,
        type: 'refresh',
        email: params.email ?? '',
        jti: nextJti,
      } satisfies Partial<RefreshJwtPayload> & { jti: string },
      { expiresIn: ttlSeconds, secret },
    )

    return { refreshToken }
  }

  async revokeRefreshToken(sub: string, jti: string): Promise<void> {
    const key = this.keyFor(sub, jti)
    await this.redis.del(key)
  }

  async verifyRefreshToken(token: string): Promise<{
    sub: string
    email?: string
    jti: string
  }> {
    const secret = this.getRefreshSecret()
    if (!secret) throw new InternalServerErrorException('Missing refresh JWT secret')

    let payload: RefreshJwtPayload
    try {
      payload = this.jwt.verify<RefreshJwtPayload>(token, { secret })
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token')
    }

    if (payload.type !== 'refresh') throw new ForbiddenException('Invalid token type')

    if (!payload.jti) throw new UnauthorizedException('Invalid refresh token')

    return { sub: payload.sub, email: payload.email, jti: payload.jti }
  }
}


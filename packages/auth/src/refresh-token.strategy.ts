import { Injectable, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import type { FastifyRequest } from 'fastify'
import type { JwtPayload } from '@futsmandu/types'
import { RefreshTokenService } from './refresh-token.service.js'

type RefreshJwtPayload = JwtPayload & {
  type: 'refresh'
  jti: string
}

const cookieExtractor = (req: FastifyRequest): string | null => {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies
  const token = cookies?.['refreshToken']
  return token ?? null
}

@Injectable()
export class RefreshTokenStrategy extends PassportStrategy(Strategy, 'refresh-jwt') {
  constructor(
    private readonly config: ConfigService,
    private readonly refreshTokenService: RefreshTokenService,
  ) {
    const secret =
      config.get<string>('REFRESH_JWT_SECRET') ??
      config.get<string>('PLAYER_JWT_SECRET') ??
      config.get<string>('OWNER_JWT_SECRET') ??
      config.get<string>('ADMIN_JWT_SECRET') ??
      ''

    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        cookieExtractor,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: secret,
      passReqToCallback: true,
    })
  }

  async validate(req: FastifyRequest, payload: RefreshJwtPayload): Promise<{
    sub: string
    email?: string
    jti: string
  }> {
    if (payload.type !== 'refresh') throw new UnauthorizedException('Invalid token type')
    if (!payload.jti) throw new UnauthorizedException('Missing refresh token id')

    const valid = await this.refreshTokenService.isRefreshTokenValid({
      sub: payload.sub,
      jti: payload.jti,
    })

    if (!valid) throw new UnauthorizedException('Invalid or expired refresh token')

    return {
      sub: payload.sub,
      email: payload.email,
      jti: payload.jti,
    }
  }
}


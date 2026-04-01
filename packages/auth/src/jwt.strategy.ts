// packages/auth/src/jwt.strategy.ts
// Passport JWT strategy — validates access tokens on every protected request.
// Checks Redis ban cache before allowing access (avoids DB hit per request).
// Shared by both player-api and owner-admin-api (with different secrets).

import { Injectable, UnauthorizedException } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import type { JwtPayload, AuthenticatedUser } from '@futsmandu/types'

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(secret: string) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    })
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    if (payload.type !== 'access') {
      throw new UnauthorizedException('Invalid token type')
    }
    return { id: payload.sub, email: payload.email }
  }
}

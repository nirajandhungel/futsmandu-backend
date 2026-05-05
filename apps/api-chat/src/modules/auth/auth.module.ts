import { Module, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ENV } from '@futsmandu/utils';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class DualJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKeyProvider: (_request: any, rawJwtToken: string, done: (err: any, secret?: string) => void) => {
        try {
          const jwt = new JwtService();
          const decoded = jwt.decode(rawJwtToken) as { role?: string } | null;
          
          if (decoded?.role === 'OWNER_ADMIN') {
            done(null, ENV['OWNER_JWT_SECRET']);
          } else {
            done(null, ENV['PLAYER_JWT_SECRET']);
          }
        } catch {
          done(null, ENV['PLAYER_JWT_SECRET']); // Fallback
        }
      },
    });
  }

  async validate(payload: any) {
    if (!payload.sub && !payload.id) {
      throw new UnauthorizedException('Invalid token payload');
    }
    return payload;
  }
}

@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
  providers: [DualJwtStrategy],
})
export class AuthModule {}

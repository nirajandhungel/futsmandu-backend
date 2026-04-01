// apps/player-api/src/modules/auth/auth.module.ts
import { Module } from '@nestjs/common'
import { PassportModule } from '@nestjs/passport'
import { JwtStrategy } from '@futsmandu/auth'
import { AuthService } from './auth.service.js'
import { AuthController } from './auth.controller.js'
import { ENV } from '@futsmandu/utils'
import { QueuesModule } from '../../queues.module.js'

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    QueuesModule,
  ],
  providers: [
    AuthService,
    {
      provide: JwtStrategy,
      useFactory: () => new JwtStrategy(ENV['PLAYER_JWT_SECRET']),
    },
  ],
  controllers: [AuthController],
})
export class AuthModule {}

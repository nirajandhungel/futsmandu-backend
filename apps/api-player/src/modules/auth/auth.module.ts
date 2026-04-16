// apps/player-api/src/modules/auth/auth.module.ts
import { Module } from '@nestjs/common'
import { PassportModule } from '@nestjs/passport'
import { JwtStrategy, OtpService, OTP_EMAIL_QUEUE } from '@futsmandu/auth'  // ← add OTP_EMAIL_QUEUE
import { getQueueToken } from '@nestjs/bullmq'                               // ← add this
import { AuthService } from './auth.service.js'
import { AuthController } from './auth.controller.js'
import { ENV } from '@futsmandu/utils'
import { QueuesModule } from '@futsmandu/queues'

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    QueuesModule,
  ],
  providers: [
    AuthService,
    OtpService,
    // Tell OtpService to use the player-emails queue for sending OTP emails
    {
      provide:     OTP_EMAIL_QUEUE,
      useExisting: getQueueToken('player-emails'),
    },
    {
      provide: JwtStrategy,
      useFactory: () => new JwtStrategy(ENV['PLAYER_JWT_SECRET']),
    },
  ],
  controllers: [AuthController],
})
export class AuthModule {}
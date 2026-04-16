// apps/owner-api/src/modules/auth/owner-auth.module.ts
import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { getQueueToken } from '@nestjs/bullmq'                               // ← add this
import { OwnerAuthController } from './owner-auth.controller.js'
import { OwnerAuthService } from './owner-auth.service.js'
import { OwnerJwtGuard } from '../../common/guards/owner-jwt.guard.js'
import { OtpService, OTP_EMAIL_QUEUE } from '@futsmandu/auth'                // ← add OTP_EMAIL_QUEUE
import { ENV } from '@futsmandu/utils'
import { QueuesModule } from '@futsmandu/queues'
import { MediaModule as SharedMediaModule } from '@futsmandu/media'

@Module({
  imports: [
    JwtModule.register({
      secret: ENV['OWNER_JWT_SECRET'],
      signOptions: { expiresIn: '15m' },
    }),
    QueuesModule,
    SharedMediaModule,
  ],
  controllers: [OwnerAuthController],
  providers: [
    OwnerAuthService,
    OtpService,
    // Tell OtpService to use the owner-emails queue for sending OTP emails
    {
      provide:     OTP_EMAIL_QUEUE,
      useExisting: getQueueToken('owner-emails'),
    },
    OwnerJwtGuard,
  ],
  exports: [JwtModule, OwnerJwtGuard],
})
export class OwnerAuthModule {}
import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { OwnerAuthController } from './owner-auth.controller.js'
import { OwnerAuthService } from './owner-auth.service.js'
import { OwnerJwtGuard } from '../../common/guards/owner-jwt.guard.js'
import { OtpService } from '@futsmandu/auth'
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
  providers: [OwnerAuthService, OtpService, OwnerJwtGuard],
  exports: [JwtModule, OwnerJwtGuard],
})
export class OwnerAuthModule {}

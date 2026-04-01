import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { OwnerAuthController } from './owner-auth.controller.js'
import { OwnerAuthService } from './owner-auth.service.js'
import { OwnerJwtGuard } from '../../common/guards/owner-jwt.guard.js'
import { ENV } from '@futsmandu/utils'
import { QueuesModule } from '../../queues.module.js'

@Module({
  imports: [
    JwtModule.register({
      secret: ENV['OWNER_JWT_SECRET'],
      signOptions: { expiresIn: '15m' },
    }),
    QueuesModule,
  ],
  controllers: [OwnerAuthController],
  providers: [OwnerAuthService, OwnerJwtGuard],
  exports: [JwtModule, OwnerJwtGuard],
})
export class OwnerAuthModule {}

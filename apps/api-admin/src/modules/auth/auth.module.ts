// apps/admin-api/src/modules/admin-auth/admin-auth.module.ts
// JwtModule registered globally in AppModule with ADMIN_JWT_SECRET — no local override needed.
import { Module } from '@nestjs/common'
import { AdminAuthController } from './auth.controller.js'
import { AdminAuthService } from './auth.service.js'
import { AdminJwtGuard } from '../../common/guards/jwt.guard.js'
import { OtpService } from '@futsmandu/auth'

@Module({
  controllers: [AdminAuthController],
  providers: [AdminAuthService, OtpService, AdminJwtGuard],
  exports: [AdminJwtGuard],
})
export class AdminAuthModule {}

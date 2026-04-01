// apps/admin-api/src/modules/admin-auth/admin-auth.module.ts
// JwtModule registered globally in AppModule with ADMIN_JWT_SECRET — no local override needed.
import { Module } from '@nestjs/common'
import { AdminAuthController } from './admin-auth.controller.js'
import { AdminAuthService } from './admin-auth.service.js'
import { AdminJwtGuard } from '../../common/guards/admin-jwt.guard.js'

@Module({
  controllers: [AdminAuthController],
  providers: [AdminAuthService, AdminJwtGuard],
  exports: [AdminJwtGuard],
})
export class AdminAuthModule {}

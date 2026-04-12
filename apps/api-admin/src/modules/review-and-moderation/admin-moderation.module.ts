import { Module } from '@nestjs/common'
import { AdminModerationController } from './admin-moderation.controller.js'
import { AdminModerationService } from './admin-moderation.service.js'
import { AdminAuthModule } from '../auth/auth.module.js'
import { RolesGuard } from '../../common/guards/roles.guard.js'

@Module({
  imports: [AdminAuthModule],
  controllers: [AdminModerationController],
  providers: [AdminModerationService, RolesGuard],
})
export class AdminModerationModule {}

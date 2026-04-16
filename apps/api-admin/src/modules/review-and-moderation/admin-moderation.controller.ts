import {
  Controller, Get, Put, Delete, Param, Query, UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { AdminModerationService } from './admin-moderation.service.js'
import { AdminJwtGuard } from '../../common/guards/jwt.guard.js'
import { RolesGuard, Roles } from '../../common/guards/roles.guard.js'
import { CurrentAdmin } from '../../common/decorators/user.decorator.js'
import type { AuthAdmin } from '../../common/guards/jwt.guard.js'

@ApiTags('Admin — Moderation')
@ApiBearerAuth('Admin-JWT')
@UseGuards(AdminJwtGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('reviews')
export class AdminModerationController {
  constructor(private readonly moderation: AdminModerationService) {}

  @Get('pending')
  @ApiOperation({ summary: 'Reviews pending approval' })
  pending(@Query('page') page?: number) {
    return this.moderation.listPendingReviews(page)
  }

  @Put(':id/approve')
  @ApiOperation({ summary: 'Approve review + recalculate venue avg_rating' })
  approve(@CurrentAdmin() admin: AuthAdmin, @Param('id') reviewId: string) {
    return this.moderation.approveReview(admin.id, reviewId)
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Hard delete review (spam/abuse) — does not recalc if unapproved' })
  remove(@CurrentAdmin() admin: AuthAdmin, @Param('id') reviewId: string) {
    return this.moderation.deleteReview(admin.id, reviewId)
  }
}
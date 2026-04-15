import {
  Controller, Get, Put, Param, Query, Body, UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { AdminOwnersService } from './admin-owners.service.js'
import { AdminJwtGuard } from '../../common/guards/jwt.guard.js'
import { RolesGuard, Roles } from '../../common/guards/roles.guard.js'
import { CurrentAdmin } from '../../common/decorators/user.decorator.js'
import { ListOwnersQueryDto, SuspendOwnerDto } from './dto/admin-owner.dto.js'
import type { AuthAdmin } from '../../common/guards/jwt.guard.js'

@ApiTags('Admin — Owners')
@ApiBearerAuth('Admin-JWT')
@UseGuards(AdminJwtGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('owners')
export class AdminOwnersController {
  constructor(private readonly adminOwners: AdminOwnersService) { }

  @Get()
  @ApiOperation({ summary: 'List owners with filters and pagination' })
  list(@Query() query: ListOwnersQueryDto) {
    return this.adminOwners.listOwners(query)
  }

  @Get('stats')
  @ApiOperation({ summary: 'Owner status counts for dashboard' })
  stats() {
    return this.adminOwners.getOwnerStats()
  }

  @Get(':ownerId')
  @ApiOperation({ summary: 'Owner detail + venues + audit history' })
  detail(@Param('ownerId') ownerId: string) {
    return this.adminOwners.getOwnerDetail(ownerId)
  }

  @Put(':ownerId/verify')
  @ApiOperation({ summary: 'Verify owner (idempotent)' })
  verify(@CurrentAdmin() admin: AuthAdmin, @Param('ownerId') ownerId: string) {
    return this.adminOwners.verifyOwner(admin.id, ownerId)
  }

  @Put(':ownerId/suspend')
  @ApiOperation({ summary: 'Suspend owner with reason' })
  suspend(
    @CurrentAdmin() admin: AuthAdmin,
    @Param('ownerId') ownerId: string,
    @Body() dto: SuspendOwnerDto,
  ) {
    return this.adminOwners.suspendOwner(admin.id, ownerId, dto.reason)
  }

  @Put(':ownerId/reinstate')
  @ApiOperation({ summary: 'Reinstate suspended owner (idempotent)' })
  reinstate(@CurrentAdmin() admin: AuthAdmin, @Param('ownerId') ownerId: string) {
    return this.adminOwners.reinstateOwner(admin.id, ownerId)
  }
}

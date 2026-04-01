import {
  Controller, Get, Post, Put, Delete, Body, Param, UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { StaffService } from './staff.service.js'
import { InviteStaffDto, UpdateStaffRoleDto } from './dto/staff.dto.js'
import { OwnerJwtGuard } from '../../common/guards/owner-jwt.guard.js'
import { RolesGuard, Roles } from '../../common/guards/roles.guard.js'
import { CurrentOwner } from '../../common/decorators/current-owner.decorator.js'
import type { AuthOwner } from '../../common/guards/owner-jwt.guard.js'

@ApiTags('Staff')
@ApiBearerAuth('Owner-JWT')
@UseGuards(OwnerJwtGuard, RolesGuard)
@Roles('OWNER_ADMIN') // Only OWNER_ADMIN can manage staff
@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  @ApiOperation({ summary: 'List all staff' })
  list(@CurrentOwner() owner: AuthOwner) {
    return this.staff.listStaff(owner.id)
  }

  @Post('invite')
  @ApiOperation({ summary: 'Invite new staff member' })
  invite(@CurrentOwner() owner: AuthOwner, @Body() dto: InviteStaffDto) {
    return this.staff.inviteStaff(owner.id, dto)
  }

  @Put(':id/role')
  @ApiOperation({ summary: 'Update staff role' })
  updateRole(
    @CurrentOwner() owner: AuthOwner,
    @Param('id') staffId: string,
    @Body() dto: UpdateStaffRoleDto,
  ) {
    return this.staff.updateRole(owner.id, staffId, dto)
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Deactivate staff member' })
  deactivate(@CurrentOwner() owner: AuthOwner, @Param('id') staffId: string) {
    return this.staff.deactivateStaff(owner.id, staffId)
  }
}

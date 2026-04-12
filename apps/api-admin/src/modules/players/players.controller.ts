import {
  Controller, Get, Put, Param, Query, Body, UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger'
import { IsString, IsNotEmpty, IsOptional, IsIn } from 'class-validator'
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { AdminUsersService } from './players.service.js'
import { AdminJwtGuard } from '../../common/guards/jwt.guard.js'
import { RolesGuard, Roles } from '../../common/guards/roles.guard.js'
import { CurrentAdmin } from '../../common/decorators/user.decorator.js'
import type { AuthAdmin } from '../../common/guards/jwt.guard.js'

class ListUsersQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string
  @ApiPropertyOptional({ enum: ['active', 'banned', 'suspended'] })
  @IsOptional() @IsIn(['active', 'banned', 'suspended']) status?: 'active' | 'banned' | 'suspended'
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) page?: number
}

class SuspendUserDto {
  @ApiProperty() @IsString() @IsNotEmpty() reason!: string
}

@ApiTags('Admin — Users')
@ApiBearerAuth('Admin-JWT')
@UseGuards(AdminJwtGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('users')
export class AdminUsersController {
  constructor(private readonly adminUsers: AdminUsersService) {}

  @Get()
  @ApiOperation({ summary: 'List players with filters' })
  list(@Query() query: ListUsersQueryDto) {
    return this.adminUsers.listUsers(query)
  }

  @Get(':id')
  @ApiOperation({ summary: 'Player detail + reliability profile' })
  detail(@Param('id') userId: string) {
    return this.adminUsers.getUserDetail(userId)
  }

  @Get(':id/bookings')
  @ApiOperation({ summary: 'Player booking history' })
  bookings(@Param('id') userId: string, @Query('page') page?: number) {
    return this.adminUsers.getUserBookings(userId, page)
  }

  @Put(':id/suspend')
  @ApiOperation({ summary: 'Suspend user' })
  suspend(
    @CurrentAdmin() admin: AuthAdmin,
    @Param('id') userId: string,
    @Body() dto: SuspendUserDto,
  ) {
    return this.adminUsers.suspendUser(admin.id, userId, dto.reason)
  }

  @Put(':id/reinstate')
  @ApiOperation({ summary: 'Reinstate suspended user' })
  reinstate(@CurrentAdmin() admin: AuthAdmin, @Param('id') userId: string) {
    return this.adminUsers.reinstateUser(admin.id, userId)
  }
}

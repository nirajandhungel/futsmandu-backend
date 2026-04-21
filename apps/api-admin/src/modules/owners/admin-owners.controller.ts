import {
  Controller, Get, Put, Patch, Param, Query, Body, UseGuards
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { IsString, IsNotEmpty, IsBoolean, IsOptional } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { AdminOwnersService } from './admin-owners.service.js'
import { AdminJwtGuard } from '../../common/guards/jwt.guard.js'
import { RolesGuard, Roles } from '../../common/guards/roles.guard.js'
import { CurrentAdmin } from '../../common/decorators/user.decorator.js'
import type { AuthAdmin } from '../../common/guards/jwt.guard.js'
import { Transform, Type } from 'class-transformer'

export class ListOwnersQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string

  @ApiPropertyOptional({ description: 'true = active, false = suspended' })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined) return undefined
    return value === 'true'
  })
  @IsBoolean()
  isActive?: boolean

  @ApiPropertyOptional({ description: 'true = approved, false = not approved' })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined) return undefined
    return value === 'true'
  })
  @IsBoolean()
  isKycApproved?: boolean

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  page?: number = 1
}

class RejectKycDto {
  @ApiProperty() @IsString() @IsNotEmpty() reason!: string
}

class UpdateStatusDto {
  @ApiProperty() @IsBoolean() @IsNotEmpty() isActive!: boolean
}

@ApiTags('Admin — Owners')
@ApiBearerAuth('Admin-JWT')
@UseGuards(AdminJwtGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('owners')
export class AdminOwnersController {
  constructor(private readonly adminOwnersService: AdminOwnersService) { }

  @Get()
  listOwners(@Query() query: ListOwnersQueryDto) {
    return this.adminOwnersService.listAllOwners(
      query.page,
      query.search,
      query.isActive,
      query.isKycApproved
    )
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get owner details' })
  getOwner(@Param('id') ownerId: string) {
    return this.adminOwnersService.getOwnerDetails(ownerId)
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Update owner active status' })
  updateStatus(
    @Param('id') ownerId: string,
    @Body() dto: UpdateStatusDto
  ) {
    return this.adminOwnersService.updateOwnerStatus(ownerId, dto.isActive)
  }

  @Get(':id/kyc-documents')
  @ApiOperation({ summary: 'Get KYC documents for owner' })
  getKycDocs(@Param('id') ownerId: string) {
    return this.adminOwnersService.getKycDocuments(ownerId)
  }

  @Put(':id/kyc/approve')
  @ApiOperation({ summary: 'Approve owner KYC' })
  approveKyc(
    @CurrentAdmin() admin: AuthAdmin,
    @Param('id') ownerId: string
  ) {
    return this.adminOwnersService.approveKyc(admin.id, ownerId)
  }

  @Put(':id/kyc/reject')
  @ApiOperation({ summary: 'Reject owner KYC' })
  rejectKyc(
    @CurrentAdmin() admin: AuthAdmin,
    @Param('id') ownerId: string,
    @Body() dto: RejectKycDto
  ) {
    return this.adminOwnersService.rejectKyc(admin.id, ownerId, dto.reason)
  }

  @Get(':id/payouts')
  @ApiOperation({ summary: 'Get owner payouts' })
  getPayouts(
    @Param('id') ownerId: string,
    @Query('page') page?: number
  ) {
    const pageNum = page ? Number(page) : 1
    return this.adminOwnersService.getOwnerPayouts(ownerId, pageNum)
  }
}

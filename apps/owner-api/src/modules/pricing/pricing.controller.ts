import {
  Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger'
import { PricingService } from './pricing.service.js'
import { CreatePricingRuleDto, UpdatePricingRuleDto, PricingPreviewQueryDto } from './dto/pricing.dto.js'
import { OwnerJwtGuard } from '../../common/guards/owner-jwt.guard.js'
import { RolesGuard } from '../../common/guards/roles.guard.js'
import { CurrentOwner } from '../../common/decorators/current-owner.decorator.js'
import type { AuthOwner } from '../../common/guards/owner-jwt.guard.js'

@ApiTags('Pricing')
@ApiBearerAuth('Owner-JWT')
@UseGuards(OwnerJwtGuard, RolesGuard)
@Controller()
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @Get('courts/:id/pricing')
  @ApiOperation({ summary: 'List all pricing rules for a court' })
  list(@CurrentOwner() owner: AuthOwner, @Param('id') courtId: string) {
    return this.pricing.listRules(owner.id, courtId)
  }

  @Post('courts/:id/pricing')
  @ApiOperation({ summary: 'Create pricing rule' })
  create(
    @CurrentOwner() owner: AuthOwner,
    @Param('id') courtId: string,
    @Body() dto: CreatePricingRuleDto,
  ) {
    return this.pricing.createRule(owner.id, courtId, dto)
  }

  @Put('pricing/:ruleId')
  @ApiOperation({ summary: 'Update pricing rule' })
  update(
    @CurrentOwner() owner: AuthOwner,
    @Param('ruleId') ruleId: string,
    @Body() dto: UpdatePricingRuleDto,
  ) {
    return this.pricing.updateRule(owner.id, ruleId, dto)
  }

  @Delete('pricing/:ruleId')
  @ApiOperation({ summary: 'Delete pricing rule (hard delete)' })
  remove(@CurrentOwner() owner: AuthOwner, @Param('ruleId') ruleId: string) {
    return this.pricing.deleteRule(owner.id, ruleId)
  }

  @Get('courts/:id/pricing/preview')
  @ApiOperation({ summary: 'Preview price for a given date/time' })
  preview(
    @CurrentOwner() owner: AuthOwner,
    @Param('id') courtId: string,
    @Query() query: PricingPreviewQueryDto,
  ) {
    return this.pricing.preview(owner.id, courtId, query.date, query.time)
  }
}

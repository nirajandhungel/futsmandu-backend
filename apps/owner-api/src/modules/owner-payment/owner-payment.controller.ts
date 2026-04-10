import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import { OwnerPaymentService } from './owner-payment.service.js'
import { OwnerJwtGuard } from '../../common/guards/owner-jwt.guard.js'
import { CurrentOwner } from '../../common/decorators/current-owner.decorator.js'
import { ListOwnerPayoutsQueryDto } from './dto/owner-payment.dto.js'
import type { AuthOwner } from '../../common/guards/owner-jwt.guard.js'

@ApiTags('Owner - Payments')
@ApiBearerAuth('Owner-JWT')
@UseGuards(OwnerJwtGuard)
@Controller('payments')
export class OwnerPaymentController {
  constructor(private readonly ownerPayment: OwnerPaymentService) {}

  @Get('payouts/stats')
  @ApiOperation({ summary: 'Owner payout stats' })
  stats(@CurrentOwner() owner: AuthOwner) {
    return this.ownerPayment.getOwnerPayoutStats(owner.id)
  }

  @Get('payouts')
  @ApiOperation({ summary: 'Owner payout list' })
  list(@CurrentOwner() owner: AuthOwner, @Query() query: ListOwnerPayoutsQueryDto) {
    return this.ownerPayment.listOwnerPayouts(owner.id, query)
  }

  @Get('payouts/:id')
  @ApiOperation({ summary: 'Owner payout detail' })
  detail(@CurrentOwner() owner: AuthOwner, @Param('id') id: string) {
    return this.ownerPayment.getOwnerPayoutDetail(id, owner.id)
  }
}

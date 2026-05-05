import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import { AdminPaymentService } from './payment.service.js'
import { AdminJwtGuard } from '../../common/guards/jwt.guard.js'
import { Roles, RolesGuard } from '../../common/guards/roles.guard.js'
import { CurrentAdmin } from '../../common/decorators/user.decorator.js'
import { ListPaymentsQueryDto, ListPayoutsQueryDto, ProcessPayoutForBookingDto, ResolvePayoutDto, RetryPayoutDto, UpdatePlatformConfigDto } from './dto/admin-payment.dto.js'

@ApiTags('Admin - Payments')
@ApiBearerAuth('Admin-JWT')
@UseGuards(AdminJwtGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('payments')
export class AdminPaymentController {
  constructor(private readonly adminPayment: AdminPaymentService) {}

  @Get('payouts/stats')
  @ApiOperation({ summary: 'Payout stats for dashboard' })
  stats() {
    return this.adminPayment.getPayoutStats()
  }

  @Get('payouts')
  @ApiOperation({ summary: 'List all payouts' })
  list(@Query() query: ListPayoutsQueryDto) {
    return this.adminPayment.listPayouts(query)
  }
  
  @Get('history')
  @ApiOperation({ summary: 'List all user payments (transactions)' })
  transactions(@Query() query: ListPaymentsQueryDto) {
    return this.adminPayment.listPayments(query)
  }

  @Get('payouts/:id')
  @ApiOperation({ summary: 'Get single payout details' })
  detail(@Param('id') id: string) {
    return this.adminPayment.getPayoutDetail(id)
  }

  @Post('payouts/:id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manual retry payout' })
  retry(@Param('id') id: string, @CurrentAdmin() admin: { id: string }, @Body() _dto: RetryPayoutDto) {
    return this.adminPayment.retryPayout(id, admin.id)
  }

  @Post('payouts/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manual payout resolution' })
  resolve(@Param('id') id: string, @CurrentAdmin() admin: { id: string }, @Body() dto: ResolvePayoutDto) {
    return this.adminPayment.resolveManually(id, admin.id, dto.note)
  }

  @Post('payouts/process')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Process payout for a booking (admin-triggered, only after booking start)' })
  processPayout(@CurrentAdmin() admin: { id: string }, @Body() dto: ProcessPayoutForBookingDto) {
    return this.adminPayment.processPayoutForBooking(dto.bookingId, admin.id)
  }

  @Post('payouts/manual')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record a manual payout to venue owner (bank transfer, cash, etc.)' })
  recordManualPayout(
    @CurrentAdmin() admin: { id: string },
    @Body() dto: { venueId: string; amountPaid: number; note: string },
  ) {
    return this.adminPayment.recordManualPayout({ ...dto, adminId: admin.id })
  }

  @Patch('bookings/:bookingId/pay-status')
  @ApiOperation({ summary: 'Update booking payment collection status' })
  updatePayStatus(
    @Param('bookingId') bookingId: string,
    @CurrentAdmin() admin: { id: string },
    @Body() dto: { status: string; note?: string },
  ) {
    return this.adminPayment.updateBookingPayStatus(bookingId, dto.status, admin.id, dto.note)
  }

  @Get('venues/payout-summary')
  @ApiOperation({ summary: 'Venue-level payout aggregation — pending/paid totals per venue' })
  venuePayoutSummary() {
    return this.adminPayment.getVenuePayoutSummary()
  }

  @Get('bookings/:bookingId/summary')
  @ApiOperation({ summary: 'Per-booking payment breakdown — deposit, remaining, payout status' })
  bookingPaymentSummary(@Param('bookingId') bookingId: string) {
    return this.adminPayment.getBookingPaymentSummary(bookingId)
  }

  @Get('config')
  @ApiOperation({ summary: 'Get payment platform config' })
  getConfig() {
    return this.adminPayment.getAllConfig()
  }

  @Put('config/:key')
  @ApiOperation({ summary: 'Update payment platform config' })
  updateConfig(@Param('key') key: string, @CurrentAdmin() admin: { id: string }, @Body() dto: UpdatePlatformConfigDto) {
    return this.adminPayment.updateConfig(key, dto, admin.id)
  }
}
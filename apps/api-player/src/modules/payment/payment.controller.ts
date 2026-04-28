// apps/player-api/src/modules/payment/payment.controller.ts
import { Controller, Post, Get, Body, Param, ParseUUIDPipe, HttpCode, HttpStatus } from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { PaymentService } from './payment.service.js'
import { KhaltiInitiateDto, KhaltiVerifyDto, EsewaInitiateDto, EsewaVerifyDto } from './dto/payment.dto.js'
import { CurrentUser } from '@futsmandu/auth'
import { PrismaService } from '@futsmandu/database'
import type { AuthenticatedUser } from '@futsmandu/types'
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { formatPaisa } from '@futsmandu/utils'

@ApiTags('Payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('khalti-initiate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Khalti initiation endpoint; currently disabled for player flow' })
  khaltiInitiate(@Body() dto: KhaltiInitiateDto, @CurrentUser() user: AuthenticatedUser) {
    return this.paymentService.initiateKhalti(dto.bookingId, user.id)
  }

  @Post('khalti-verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify Khalti callback for legacy/manual payment flows' })
  khaltiVerify(@Body() dto: KhaltiVerifyDto) {
    return this.paymentService.verifyKhalti(dto.pidx, dto.bookingId)
  }

  @Post('esewa-initiate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'eSewa initiation endpoint; currently disabled for player flow' })
  esewaInitiate(@Body() dto: EsewaInitiateDto, @CurrentUser() user: AuthenticatedUser) {
    return this.paymentService.initiateEsewa(dto.bookingId, user.id)
  }

  @Post('esewa-verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify eSewa callback for legacy/manual payment flows' })
  esewaVerify(@Body() dto: EsewaVerifyDto) {
    return this.paymentService.verifyEsewa(dto.data)
  }

  @Get('history')
  @ApiOperation({ summary: 'Get payment history for the current player' })
  async history(@CurrentUser() user: AuthenticatedUser) {
    const payments = await this.prisma.payments.findMany({
      where: { player_id: user.id },
      orderBy: { initiated_at: 'desc' },
      take: 50,
      select: {
        id: true, booking_id: true, amount: true, gateway: true, status: true,
        initiated_at: true, completed_at: true,
        booking: { select: { booking_date: true, start_time: true, court: { select: { name: true, venue: { select: { name: true } } } } } },
      },
    })
    return payments.map((p: any) => ({ ...p, displayAmount: formatPaisa(p.amount) }))
  }

  @Get(':id')
  @ApiOperation({ summary: 'Payment detail (no gateway_response — sensitive)' })
  async getPayment(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    const payment = await this.prisma.payments.findUnique({
      where: { id },
      select: { id: true, booking_id: true, player_id: true, amount: true, gateway: true, status: true, gateway_tx_id: true, initiated_at: true, completed_at: true, refund_initiated_at: true, refund_completed_at: true },
    })
    if (!payment) throw new NotFoundException('Payment not found')
    if (payment.player_id !== user.id) throw new ForbiddenException('Access denied')
    return { ...payment, displayAmount: formatPaisa(payment.amount) }
  }
}
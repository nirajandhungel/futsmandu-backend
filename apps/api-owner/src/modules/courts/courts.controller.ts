// apps/owner-api/src/modules/courts/courts.controller.ts
import { Controller, Get, Post, Delete, Param, Query, Body, UseGuards } from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger'
import { CourtsService } from './courts.service.js'
import { OwnerJwtGuard } from '../../common/guards/owner-jwt.guard.js'
import { CurrentOwner } from '../../common/decorators/current-owner.decorator.js'

@ApiTags('Courts')
@ApiBearerAuth('Owner-JWT')
@UseGuards(OwnerJwtGuard)
@Controller('courts')
export class CourtsController {
  constructor(private readonly courts: CourtsService) {}

  @Get(':courtId/calendar')
  @ApiOperation({ summary: 'Get court slot calendar for a specific date' })
  @ApiQuery({ name: 'date', description: 'YYYY-MM-DD', example: '2025-10-10' })
  getCalendar(
    @CurrentOwner() owner: { id: string },
    @Param('courtId') courtId: string,
    @Query('date') date: string,
  ) {
    return this.courts.getCourtCalendar(owner.id, courtId, date)
  }

  @Post(':courtId/blocks')
  @ApiOperation({ summary: 'Block a court slot (maintenance, private reservation)' })
  blockSlot(
    @CurrentOwner() owner: { id: string },
    @Param('courtId') courtId: string,
    @Body('date') date: string,
    @Body('startTime') startTime: string,
    @Body('reason') reason?: string,
  ) {
    return this.courts.blockSlot(owner.id, courtId, date, startTime, reason)
  }

  @Delete('blocks/:blockId')
  @ApiOperation({ summary: 'Remove a court block' })
  unblockSlot(
    @CurrentOwner() owner: { id: string },
    @Param('blockId') blockId: string,
  ) {
    return this.courts.unblockSlot(owner.id, blockId)
  }
}

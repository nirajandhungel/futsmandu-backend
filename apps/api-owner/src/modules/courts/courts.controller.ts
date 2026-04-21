// apps/owner-api/src/modules/courts/courts.controller.ts
import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiParam,
} from "@nestjs/swagger";
import { CourtsService } from "./courts.service.js";
import { BlockSlotDto } from "./dto/block-slot.dto.js";
import { OwnerJwtGuard } from "../../common/guards/owner-jwt.guard.js";
import { CurrentOwner } from "../../common/decorators/current-owner.decorator.js";

@ApiTags("Courts")
@ApiBearerAuth("Owner-JWT")
@UseGuards(OwnerJwtGuard)
@Controller("courts")
export class CourtsController {
  constructor(private readonly courts: CourtsService) {}

  // ── GET /courts/:courtId/calendar?date=YYYY-MM-DD ─────────────────────────
  // Returns full slot grid for the day:
  //   AVAILABLE  — free to book
  //   HELD       — Redis advisory lock (player mid-payment)
  //   CONFIRMED/PENDING_PAYMENT — real booking  → bookingId, playerName, bookingType
  //   BLOCKED    — owner block                  → blockId,   blockType,  note
  @Get(":courtId/calendar")
  @ApiOperation({ summary: "Get court slot calendar for a specific date" })
  @ApiParam({ name: "courtId", description: "Court UUID" })
  @ApiQuery({ name: "date", description: "YYYY-MM-DD", example: "2026-05-01" })
  getCalendar(
    @CurrentOwner() owner: { id: string },
    @Param("courtId") courtId: string,
    @Query("date") date: string,
  ) {
    return this.courts.getCourtCalendar(owner.id, courtId, date);
  }

  // ── POST /courts/:courtId/blocks ──────────────────────────────────────────
  // Block a slot for maintenance, event, private reservation, or personal use.
  // Response contains blockId (not bookingId) — Flutter uses this for unblock.
  @Post(":courtId/blocks")
  @ApiOperation({
    summary: "Block a court slot",
    description:
      "Blocks a slot for MAINTENANCE, PRIVATE_RESERVATION, EVENT, or PERSONAL use. " +
      "Returns blockId which is used to unblock via DELETE /courts/blocks/:blockId.",
  })
  @ApiParam({ name: "courtId", description: "Court UUID" })
  blockSlot(
    @CurrentOwner() owner: { id: string },
    @Param("courtId") courtId: string,
    @Body() body: BlockSlotDto,
  ) {
    return this.courts.blockSlot(owner.id, courtId, body);
  }

  // ── DELETE /courts/blocks/:blockId ────────────────────────────────────────
  // Unblock a previously blocked slot.
  // Only works on blocks (total_amount=0, player_id=null) — never on real bookings.
  @Delete("blocks/:blockId")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove a court block" })
  @ApiParam({ name: "blockId", description: "Block ID returned from POST /blocks" })
  unblockSlot(
    @CurrentOwner() owner: { id: string },
    @Param("blockId") blockId: string,
  ) {
    return this.courts.unblockSlot(owner.id, blockId);
  }
}
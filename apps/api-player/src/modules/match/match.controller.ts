// apps/player-api/src/modules/match/match.controller.ts
import { Controller, Get, Post, Put, Delete, Body, Param, ParseUUIDPipe, HttpCode, HttpStatus } from '@nestjs/common'
import { IsArray, IsEnum, IsOptional, IsString } from 'class-validator'
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger'
import { MatchService } from './match.service.js'
import { CurrentUser, Public } from '@futsmandu/auth'
import type { AuthenticatedUser } from '@futsmandu/types'

class JoinMatchDto { @IsEnum(['goalkeeper','defender','midfielder','striker']) @IsOptional() position?: string }
class SetTeamsDto  { @IsArray() A!: string[]; @IsArray() B!: string[] }
class ResultDto    { @IsEnum(['A','B','draw']) winner!: 'A' | 'B' | 'draw' }

@ApiTags('Matches')
@ApiBearerAuth()
@Controller()
export class MatchController {
  constructor(private readonly matchService: MatchService) {}

  @Get('matches/:id')
  getMatch(@Param('id', ParseUUIDPipe) id: string) { return this.matchService.getMatch(id) }

  @Post('matches/:id/join')
  @HttpCode(HttpStatus.CREATED)
  join(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthenticatedUser, @Body() dto: JoinMatchDto) {
    return this.matchService.joinMatch(id, u.id, dto.position)
  }

  @Put('matches/:id/approve/:userId')
  approve(@Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string, @CurrentUser() u: AuthenticatedUser) {
    return this.matchService.approveMember(id, u.id, userId)
  }

  @Put('matches/:id/reject/:userId')
  reject(@Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string, @CurrentUser() u: AuthenticatedUser) {
    return this.matchService.rejectMember(id, u.id, userId)
  }

  @Delete('matches/:id/leave')
  leave(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.matchService.leaveMatch(id, u.id)
  }

  @Put('matches/:id/teams')
  setTeams(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthenticatedUser, @Body() dto: SetTeamsDto) {
    return this.matchService.setTeams(id, u.id, dto)
  }

  @Post('matches/:id/result')
  @HttpCode(HttpStatus.OK)
  result(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthenticatedUser, @Body() dto: ResultDto) {
    return this.matchService.recordResult(id, u.id, dto.winner)
  }

  @Post('matches/:id/invite-link')
  @HttpCode(HttpStatus.OK)
  inviteLink(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.matchService.generateInviteLink(id, u.id)
  }

  @Public()
  @Get('invite/:token/preview')
  invitePreview(@Param('token') token: string) { return this.matchService.getInvitePreview(token) }
}
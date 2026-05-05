import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { ChatService } from './chat.service.js';
import {
  CreateDirectChatDto,
  CreateGroupChatDto,
  AddParticipantDto,
  RemoveParticipantDto,
  GetMessagesQueryDto,
  ChatUserRole,
} from './dto/chat.dto.js';
import { JwtAuthGuard } from '@futsmandu/auth';
import type { FastifyRequest } from 'fastify';
import type { ChatIdentity } from './chat.service.js';

/** Extract identity from JWT guard — same shape as player/owner tokens */
function getIdentity(req: FastifyRequest): ChatIdentity {
  const user = (req as any).user as { id?: string; sub?: string; role?: string };
  const userId = (user.id ?? user.sub) as string;
  // Player tokens have no 'role' field; Owner tokens have role 'OWNER_ADMIN'
  const role = user.role === 'OWNER_ADMIN' ? ChatUserRole.OWNER : ChatUserRole.PLAYER;
  return { userId, role };
}

@ApiTags('Chat')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('chats')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  // ── POST /chats/direct ────────────────────────────────────────────────────

  @ApiOperation({ summary: 'Get or create a 1-to-1 DIRECT chat' })
  @Post('direct')
  @HttpCode(HttpStatus.OK)
  async createOrGetDirectChat(
    @Req() req: FastifyRequest,
    @Body() dto: CreateDirectChatDto,
  ) {
    const me = getIdentity(req);
    return this.chatService.getOrCreateDirectChat(me, dto);
  }

  // ── POST /chats/group ─────────────────────────────────────────────────────

  @ApiOperation({ summary: 'Create a GROUP chat' })
  @Post('group')
  async createGroupChat(
    @Req() req: FastifyRequest,
    @Body() dto: CreateGroupChatDto,
  ) {
    const me = getIdentity(req);
    return this.chatService.createGroupChat(me, dto);
  }

  // ── GET /chats ────────────────────────────────────────────────────────────

  @ApiOperation({ summary: 'List all chats for the current user' })
  @Get()
  async getUserChats(@Req() req: FastifyRequest) {
    const me = getIdentity(req);
    return this.chatService.getUserChats(me);
  }

  // ── GET /chats/:id/messages ───────────────────────────────────────────────

  @ApiOperation({ summary: 'Get messages with cursor-based pagination' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @Get(':id/messages')
  async getMessages(
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) chatId: string,
    @Query() query: GetMessagesQueryDto,
  ) {
    const me = getIdentity(req);
    return this.chatService.getMessages(chatId, me, query);
  }

  // ── POST /chats/:id/add-participant ───────────────────────────────────────

  @ApiOperation({ summary: 'Add participant to GROUP chat (ADMIN only)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @Post(':id/add-participant')
  async addParticipant(
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) chatId: string,
    @Body() dto: AddParticipantDto,
  ) {
    const me = getIdentity(req);
    await this.chatService.addParticipant(chatId, me, dto);
    return { success: true };
  }

  // ── POST /chats/:id/remove-participant ────────────────────────────────────

  @ApiOperation({ summary: 'Remove participant from GROUP chat, or leave group' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @Post(':id/remove-participant')
  async removeParticipant(
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) chatId: string,
    @Body() dto: RemoveParticipantDto,
  ) {
    const me = getIdentity(req);
    await this.chatService.removeParticipant(chatId, me, dto);
    return { success: true };
  }

  // ── GET /chats/:id ────────────────────────────────────────────────────────

  @ApiOperation({ summary: 'Get a single chat by ID' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @Get(':id')
  async getChat(
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) chatId: string,
  ) {
    const me = getIdentity(req);
    await this.chatService.assertParticipant(chatId, me);
    return this.chatService.getChatById(chatId);
  }
}

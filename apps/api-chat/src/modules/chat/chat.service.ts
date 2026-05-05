import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '@futsmandu/database';
import {
  ChatUserRole,
  ChatType,
  MessageType,
  CreateDirectChatDto,
  CreateGroupChatDto,
  AddParticipantDto,
  RemoveParticipantDto,
  GetMessagesQueryDto,
  ParticipantDto,
} from './dto/chat.dto.js';
import type { chat_user_role, chat_message_type } from '@futsmandu/database';

// ── Identity ─────────────────────────────────────────────────────────────────
export interface ChatIdentity {
  userId: string;
  role: ChatUserRole;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function toPrismaRole(role: ChatUserRole): chat_user_role {
  return role as unknown as chat_user_role;
}

function toPrismaMsgType(type: MessageType): chat_message_type {
  return type as unknown as chat_message_type;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Direct Chat ─────────────────────────────────────────────────────────────

  /**
   * Create or return existing DIRECT chat between two users.
   * RULE: Only ONE direct chat per (userId+role) pair — enforced here.
   */
  async getOrCreateDirectChat(
    me: ChatIdentity,
    dto: CreateDirectChatDto,
  ) {
    const other = dto.participant;

    // Prevent self-chat
    if (me.userId === other.userId && me.role === other.role) {
      throw new BadRequestException('Cannot start a chat with yourself');
    }

    // Find existing DIRECT chat that contains BOTH participants (and is not left)
    const existing = await this.prisma.chats.findFirst({
      where: {
        type: 'DIRECT',
        deleted_at: null,
        participants: {
          every: { left_at: null, deleted_at: null },
        },
        AND: [
          {
            participants: {
              some: {
                user_id: me.userId,
                user_role: toPrismaRole(me.role),
                left_at: null,
                deleted_at: null,
              },
            },
          },
          {
            participants: {
              some: {
                user_id: other.userId,
                user_role: toPrismaRole(other.role),
                left_at: null,
                deleted_at: null,
              },
            },
          },
        ],
      },
      include: {
        participants: true,
        _count: { select: { messages: true } },
      },
    });

    if (existing) return existing;

    // Create new DIRECT chat
    return this.prisma.chats.create({
      data: {
        type: 'DIRECT',
        booking_id: dto.bookingId ?? null,
        created_by_id: me.userId,
        created_by_role: toPrismaRole(me.role),
        participants: {
          create: [
            {
              user_id: me.userId,
              user_role: toPrismaRole(me.role),
              role_in_chat: 'ADMIN',
            },
            {
              user_id: other.userId,
              user_role: toPrismaRole(other.role),
              role_in_chat: 'MEMBER',
            },
          ],
        },
      },
      include: {
        participants: true,
        _count: { select: { messages: true } },
      },
    });
  }

  // ── Group Chat ──────────────────────────────────────────────────────────────

  async createGroupChat(me: ChatIdentity, dto: CreateGroupChatDto) {
    if (!dto.name?.trim()) {
      throw new BadRequestException('Group name is required');
    }
    if (dto.participants.length < 2) {
      throw new BadRequestException('Group requires at least 2 other participants');
    }

    // Deduplicate participants
    const uniqueParticipants = this.deduplicateParticipants(dto.participants);

    return this.prisma.chats.create({
      data: {
        type: 'GROUP',
        name: dto.name.trim(),
        booking_id: dto.bookingId ?? null,
        created_by_id: me.userId,
        created_by_role: toPrismaRole(me.role),
        participants: {
          create: [
            // Creator is ADMIN
            {
              user_id: me.userId,
              user_role: toPrismaRole(me.role),
              role_in_chat: 'ADMIN',
            },
            // Others are MEMBERs
            ...uniqueParticipants.map(p => ({
              user_id: p.userId,
              user_role: toPrismaRole(p.role as ChatUserRole),
              role_in_chat: 'MEMBER' as const,
            })),
          ],
        },
      },
      include: {
        participants: true,
        _count: { select: { messages: true } },
      },
    });
  }

  // ── Get User Chats ──────────────────────────────────────────────────────────

  async getUserChats(me: ChatIdentity) {
    const chats = await this.prisma.chats.findMany({
      where: {
        deleted_at: null,
        participants: {
          some: {
            user_id: me.userId,
            user_role: toPrismaRole(me.role),
            left_at: null,
            deleted_at: null,
          },
        },
      },
      include: {
        participants: {
          where: { left_at: null, deleted_at: null },
        },
        messages: {
          orderBy: { created_at: 'desc' },
          take: 1,
        },
        _count: { select: { messages: true } },
      },
      orderBy: { updated_at: 'desc' },
    });

    return chats;
  }

  // ── Get Messages (cursor-based) ──────────────────────────────────────────────

  async getMessages(chatId: string, me: ChatIdentity, query: GetMessagesQueryDto) {
    await this.assertParticipant(chatId, me);

    const limit = query.limit ?? 20;

    const messages = await this.prisma.messages.findMany({
      where: {
        chat_id: chatId,
        deleted_at: null,
        // Cursor: get messages older than the cursor message
        ...(query.cursor
          ? {
              created_at: {
                lt: await this.getMessageTimestamp(query.cursor),
              },
            }
          : {}),
      },
      orderBy: { created_at: 'desc' },
      take: limit + 1, // fetch one extra to detect if there's more
      include: {
        reads: true,
      },
    });

    const hasMore = messages.length > limit;
    if (hasMore) messages.pop();

    return {
      messages: messages.reverse(), // return in chronological order
      hasMore,
      nextCursor: hasMore && messages.length > 0 ? messages[0]!.id : null,
    };
  }

  private async getMessageTimestamp(messageId: string): Promise<Date> {
    const msg = await this.prisma.messages.findUnique({ where: { id: messageId } });
    if (!msg) throw new NotFoundException('Cursor message not found');
    return msg.created_at;
  }

  // ── Send Message ─────────────────────────────────────────────────────────────

  async sendMessage(
    chatId: string,
    me: ChatIdentity,
    content: string,
    type: MessageType = MessageType.TEXT,
  ) {
    await this.assertParticipant(chatId, me);

    return this.prisma.messages.create({
      data: {
        chat_id: chatId,
        sender_id: me.userId,
        sender_role: toPrismaRole(me.role),
        content,
        type: toPrismaMsgType(type),
      },
    });
  }

  // ── Add Participant (only GROUP, only ADMIN) ──────────────────────────────────

  async addParticipant(chatId: string, me: ChatIdentity, dto: AddParticipantDto) {
    const chat = await this.getChat(chatId);
    if (chat.type !== 'GROUP') throw new BadRequestException('Cannot add participants to a DIRECT chat');

    await this.assertAdmin(chatId, me);

    const participant = dto.participant;

    // Check if already active participant
    const existing = await this.prisma.chat_participants.findFirst({
      where: {
        chat_id: chatId,
        user_id: participant.userId,
        user_role: toPrismaRole(participant.role),
        left_at: null,
        deleted_at: null,
      },
    });
    if (existing) throw new ConflictException('User is already a participant');

    await this.prisma.chat_participants.create({
      data: {
        chat_id: chatId,
        user_id: participant.userId,
        user_role: toPrismaRole(participant.role),
        role_in_chat: 'MEMBER',
      },
    });

    // System message
    await this.createSystemMessage(chatId, `A new member joined the group`);
  }

  // ── Remove Participant (ADMIN removes others, or self-leave) ─────────────────

  async removeParticipant(chatId: string, me: ChatIdentity, dto: RemoveParticipantDto) {
    const chat = await this.getChat(chatId);
    if (chat.type !== 'GROUP') throw new BadRequestException('Cannot remove participants from a DIRECT chat');

    const target = dto.participant;
    const isSelf = target.userId === me.userId && target.role === me.role;

    if (!isSelf) {
      // Only ADMIN can remove others
      await this.assertAdmin(chatId, me);
    }

    const participant = await this.prisma.chat_participants.findFirst({
      where: {
        chat_id: chatId,
        user_id: target.userId,
        user_role: toPrismaRole(target.role),
        left_at: null,
        deleted_at: null,
      },
    });
    if (!participant) throw new NotFoundException('Participant not found in chat');

    await this.prisma.chat_participants.update({
      where: { id: participant.id },
      data: { left_at: new Date() },
    });

    await this.createSystemMessage(
      chatId,
      isSelf ? `A member left the group` : `A member was removed from the group`,
    );
  }

  // ── Mark Read ─────────────────────────────────────────────────────────────────

  async markMessageRead(messageId: string, me: ChatIdentity) {
    const message = await this.prisma.messages.findUnique({ where: { id: messageId } });
    if (!message) throw new NotFoundException('Message not found');

    await this.assertParticipant(message.chat_id, me);

    // Upsert – idempotent
    await this.prisma.message_reads.upsert({
      where: {
        message_id_user_id_user_role: {
          message_id: messageId,
          user_id: me.userId,
          user_role: toPrismaRole(me.role),
        },
      },
      create: {
        message_id: messageId,
        user_id: me.userId,
        user_role: toPrismaRole(me.role),
      },
      update: { read_at: new Date() },
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  async assertParticipant(chatId: string, me: ChatIdentity): Promise<void> {
    const participant = await this.prisma.chat_participants.findFirst({
      where: {
        chat_id: chatId,
        user_id: me.userId,
        user_role: toPrismaRole(me.role),
        left_at: null,
        deleted_at: null,
      },
    });
    if (!participant) {
      throw new ForbiddenException('You are not a participant in this chat');
    }
  }

  async assertAdmin(chatId: string, me: ChatIdentity): Promise<void> {
    const participant = await this.prisma.chat_participants.findFirst({
      where: {
        chat_id: chatId,
        user_id: me.userId,
        user_role: toPrismaRole(me.role),
        role_in_chat: 'ADMIN',
        left_at: null,
        deleted_at: null,
      },
    });
    if (!participant) {
      throw new ForbiddenException('Only group admins can perform this action');
    }
  }

  async getChatById(chatId: string) {
    return this.prisma.chats.findUnique({
      where: { id: chatId },
      include: {
        participants: {
          where: { left_at: null, deleted_at: null },
        },
      },
    });
  }

  private async getChat(chatId: string) {
    const chat = await this.prisma.chats.findUnique({ where: { id: chatId, deleted_at: null } });
    if (!chat) throw new NotFoundException('Chat not found');
    return chat;
  }

  async createSystemMessage(chatId: string, content: string) {
    return this.prisma.messages.create({
      data: {
        chat_id: chatId,
        sender_id: '00000000-0000-0000-0000-000000000000', // system UUID
        sender_role: 'PLAYER' as unknown as chat_user_role, // system, role irrelevant
        content,
        type: 'SYSTEM' as unknown as chat_message_type,
      },
    });
  }

  private deduplicateParticipants(participants: ParticipantDto[]): ParticipantDto[] {
    const seen = new Set<string>();
    return participants.filter(p => {
      const key = `${p.userId}:${p.role}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

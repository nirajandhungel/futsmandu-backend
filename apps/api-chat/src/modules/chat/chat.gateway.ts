import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
  WsException,
} from '@nestjs/websockets';
import { Logger, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { ChatService, ChatIdentity } from './chat.service.js';
import { WsJwtGuard } from './guards/ws-jwt.guard.js';
import { WsSendMessageDto, WsJoinChatDto, WsTypingDto, WsMarkReadDto, MessageType, ChatUserRole } from './dto/chat.dto.js';
import { JwtService } from '@nestjs/jwt';

function chatRoom(chatId: string) {
  return `chat:${chatId}`;
}

@WebSocketGateway({
  cors: { origin: '*', credentials: true },
  namespace: '/chat',
  transports: ['websocket', 'polling'],
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
  ) {}

  // ── Connection lifecycle ────────────────────────────────────────────────────

  async handleConnection(client: Socket): Promise<void> {
    const identity = await this.authenticate(client);
    if (!identity) {
      this.logger.warn(`WS rejected: no valid token (${client.id})`);
      client.disconnect();
      return;
    }
    client.data['identity'] = identity;
    this.logger.log(`WS connected: ${identity.role}:${identity.userId} (${client.id})`);

    // Auto-join all rooms for this user's active chats
    const chats = await this.chatService.getUserChats(identity);
    for (const chat of chats) {
      await client.join(chatRoom(chat.id));
    }
  }

  handleDisconnect(client: Socket): void {
    const identity: ChatIdentity | undefined = client.data['identity'];
    if (identity) {
      this.logger.log(`WS disconnected: ${identity.role}:${identity.userId} (${client.id})`);
    }
  }

  // ── join_chat ───────────────────────────────────────────────────────────────

  @UseGuards(WsJwtGuard)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage('join_chat')
  async handleJoinChat(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: WsJoinChatDto,
  ) {
    const identity: ChatIdentity = client.data['identity'];
    try {
      await this.chatService.assertParticipant(payload.chatId, identity);
      await client.join(chatRoom(payload.chatId));
      this.logger.log(`${identity.role}:${identity.userId} joined ${chatRoom(payload.chatId)}`);
      return { event: 'joined', chatId: payload.chatId };
    } catch (err) {
      throw new WsException((err as Error).message ?? 'Cannot join chat');
    }
  }

  // ── send_message ────────────────────────────────────────────────────────────

  @UseGuards(WsJwtGuard)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage('send_message')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: WsSendMessageDto,
  ) {
    const identity: ChatIdentity = client.data['identity'];
    try {
      const message = await this.chatService.sendMessage(
        payload.chatId,
        identity,
        payload.content,
        payload.type ?? MessageType.TEXT,
      );

      // Broadcast to everyone in the room (including sender)
      const event = {
        event: 'receive_message',
        data: {
          id: message.id,
          chatId: message.chat_id,
          senderId: message.sender_id,
          senderRole: message.sender_role,
          content: message.content,
          type: message.type,
          createdAt: message.created_at,
        },
      };

      this.server.to(chatRoom(payload.chatId)).emit('receive_message', event.data);

      return { event: 'message_sent', messageId: message.id };
    } catch (err) {
      throw new WsException((err as Error).message ?? 'Cannot send message');
    }
  }

  // ── typing ─────────────────────────────────────────────────────────────────

  @UseGuards(WsJwtGuard)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage('typing')
  async handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: WsTypingDto,
  ) {
    const identity: ChatIdentity = client.data['identity'];
    try {
      await this.chatService.assertParticipant(payload.chatId, identity);

      // Broadcast to others in the room (not sender)
      client.to(chatRoom(payload.chatId)).emit('typing', {
        chatId: payload.chatId,
        userId: identity.userId,
        role: identity.role,
        isTyping: payload.isTyping ?? true,
      });
      return { event: 'ok' };
    } catch (err) {
      throw new WsException((err as Error).message ?? 'Cannot send typing indicator');
    }
  }

  // ── mark_read ───────────────────────────────────────────────────────────────

  @UseGuards(WsJwtGuard)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage('mark_read')
  async handleMarkRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: WsMarkReadDto,
  ) {
    const identity: ChatIdentity = client.data['identity'];
    try {
      await this.chatService.markMessageRead(payload.messageId, identity);

      // Notify others in room about the read receipt
      client.to(chatRoom(payload.chatId)).emit('message_read', {
        chatId: payload.chatId,
        messageId: payload.messageId,
        userId: identity.userId,
        role: identity.role,
      });
      return { event: 'marked_read' };
    } catch (err) {
      throw new WsException((err as Error).message ?? 'Cannot mark message as read');
    }
  }

  // ── Broadcast helpers (called from service/controller) ──────────────────────

  broadcastToChat(chatId: string, event: string, data: unknown) {
    this.server.to(chatRoom(chatId)).emit(event, data);
  }

  // ── Internal auth ───────────────────────────────────────────────────────────

  private async authenticate(client: Socket): Promise<ChatIdentity | null> {
    const token = this.extractToken(client);
    if (!token) return null;

    // Try PLAYER token
    const playerSecret = process.env['PLAYER_JWT_SECRET'];
    const ownerSecret = process.env['OWNER_JWT_SECRET'];

    try {
      const payload = await this.jwtService.verifyAsync<{ sub: string }>(token, {
        secret: playerSecret,
      });
      return { userId: payload.sub, role: ChatUserRole.PLAYER };
    } catch { /* try owner */ }

    try {
      const payload = await this.jwtService.verifyAsync<{ sub: string }>(token, {
        secret: ownerSecret,
      });
      return { userId: payload.sub, role: ChatUserRole.OWNER };
    } catch { /* invalid */ }

    return null;
  }

  private extractToken(client: Socket): string | null {
    const auth = client.handshake.headers['authorization'];
    if (auth && typeof auth === 'string' && auth.startsWith('Bearer ')) {
      return auth.slice(7);
    }
    const q = client.handshake.query['token'];
    if (q && typeof q === 'string') return q;
    return null;
  }
}

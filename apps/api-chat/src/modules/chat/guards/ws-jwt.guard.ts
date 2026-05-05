import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Socket } from 'socket.io';
import { ENV } from '@futsmandu/utils';
import type { ChatIdentity } from '../chat.service.js';
import { ChatUserRole } from '../dto/chat.dto.js';

interface JwtPayload {
  sub: string;
  role?: string; // only on owner tokens
  type?: string; // 'player' | 'owner'
}

/**
 * Dual-JWT WebSocket guard.
 * - Tries PLAYER_JWT_SECRET first (if 'type'='player' or no type)
 * - Falls back to OWNER_JWT_SECRET  (if 'type'='owner')
 * - Attaches { userId, role } to socket.data.identity
 */
@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client: Socket = context.switchToWs().getClient();
    const token = this.extractToken(client);

    if (!token) {
      client.disconnect();
      return false;
    }

    const identity = await this.verifyToken(token);
    if (!identity) {
      client.disconnect();
      return false;
    }

    client.data['identity'] = identity;
    return true;
  }

  private extractToken(client: Socket): string | null {
    // Priority: auth header → query → cookie
    const authHeader = client.handshake.headers['authorization'];
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }
    const query = client.handshake.query['token'];
    if (query && typeof query === 'string') return query;

    return null;
  }

  private async verifyToken(token: string): Promise<ChatIdentity | null> {
    // Try player secret
    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: ENV.PLAYER_JWT_SECRET,
      });
      return { userId: payload.sub, role: ChatUserRole.PLAYER };
    } catch {
      // not a player token — try owner
    }

    // Try owner secret
    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: ENV.OWNER_JWT_SECRET,
      });
      return { userId: payload.sub, role: ChatUserRole.OWNER };
    } catch {
      this.logger.warn('WebSocket auth failed — invalid token');
      return null;
    }
  }
}

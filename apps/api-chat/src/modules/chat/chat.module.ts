import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ChatService } from './chat.service.js';
import { ChatController } from './chat.controller.js';
import { ChatGateway } from './chat.gateway.js';
import { WsJwtGuard } from './guards/ws-jwt.guard.js';
import { ENV } from '@futsmandu/utils';

@Module({
  imports: [
    // Provide both secrets — gateway verifies both player & owner tokens
    JwtModule.register({
      global: false,
      secret: ENV['PLAYER_JWT_SECRET'],
      signOptions: { expiresIn: '15m' },
    }),
  ],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway, WsJwtGuard],
  exports: [ChatService],
})
export class ChatModule {}

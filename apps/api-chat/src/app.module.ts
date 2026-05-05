import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { SentryModule } from '@sentry/nestjs/setup';

import { PrismaModule } from '@futsmandu/database';
import { RedisModule } from '@futsmandu/redis';
import { AuthModule } from './modules/auth/auth.module.js';

import { ChatModule } from './modules/chat/chat.module.js';

import { AuditModule, AuditInterceptor, AuditService } from '@futsmandu/audit';
import { ENV } from '@futsmandu/utils';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
      cache: true,
    }),

    SentryModule.forRoot(),

    PrismaModule,
    RedisModule,
    AuditModule,

    // Chat microservice may verify JWTs from both player and owner.
    // AuthGuard and custom WebSocket guard will handle specific logic.
    AuthModule,

    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),

    ChatModule,
  ],
  providers: [
    {
      provide: 'SENTRY_DSN',
      useFactory: (config: ConfigService) => config.get<string>('SENTRY_DSN'),
      inject: [ConfigService],
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useFactory: (auditService: AuditService) => new AuditInterceptor(auditService, {
        actorType: 'SYSTEM',
        actorRole: 'CHAT',
        identityProperty: 'user',
        urlNamespace: 'chat',
      }),
      inject: [AuditService],
    },
  ],
})
export class AppModule {}

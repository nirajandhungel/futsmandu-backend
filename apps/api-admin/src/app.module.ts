// apps/admin-api/src/app.module.ts
// Root module for Admin API — only admin modules.
// Owner modules are NOT imported here.
// IP whitelist middleware applied globally via configure().
// JWT: ADMIN_JWT_SECRET only, 8h sessions.
// BullMQ: emails + admin-alerts queues (no notifications/sms/image queues).

import { Module, MiddlewareConsumer, NestModule, RequestMethod } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'
import { ThrottlerModule } from '@nestjs/throttler'
import { SentryModule } from '@sentry/nestjs/setup'

import { PrismaModule } from '@futsmandu/database'
import { QueuesModule } from '@futsmandu/queues'

import { IpWhitelistMiddleware }   from './common/middleware/ip-whitelist.middleware.js'
import { AdminAuthModule }         from './modules/auth/auth.module.js'
import { AdminUsersModule }        from './modules/players/players.module.js'
import { AdminOwnersModule }       from './modules/owners/admin-owners.module.js'
import { AdminVenuesModule }       from './modules/venues/admin-venues.module.js'
import { AdminBookingModule }      from './modules/booking/admin-booking.module.js'
import { AdminPenaltiesModule }    from './modules/penalties/penalties.module.js'
import { AdminModerationModule }   from './modules/review-and-moderation/admin-moderation.module.js'
import { AdminAnalyticsModule }    from './modules/analytics/analytics.module.js'
import { AdminHealthModule }       from './modules/health/health.module.js'
import { AdminPaymentModule } from './modules/payment/payment.module.js'
import { ENV } from '@futsmandu/utils'


@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.admin', '../../.env', '.env'],
      cache: true,
    }),

    SentryModule.forRoot(),

    PrismaModule,

    // Admin JWT — 8h sessions, separate secret from owner and player
    JwtModule.register({
      global: true,
      secret: ENV['ADMIN_JWT_SECRET'],
      signOptions: { expiresIn: '8h' },
    }),

    // Centralized BullMQ registration (prevents duplicate queue/worker instantiation)
    QueuesModule,

    // Strict rate limiting for admin — fewer users, more critical operations
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),

    AdminAuthModule,
    AdminUsersModule,
    AdminOwnersModule,
    AdminVenuesModule,
    AdminBookingModule,
    AdminPenaltiesModule,
    AdminModerationModule,
    AdminAnalyticsModule,
    AdminPaymentModule,
    AdminHealthModule,
  ],
  providers: [
    {
      provide: 'SENTRY_DSN',
      useFactory: (config: ConfigService) => config.get<string>('SENTRY_DSN'),
      inject: [ConfigService],
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Apply IP whitelist to all admin routes except health check
    // Health check is public so load balancers can probe it
    consumer
      .apply(IpWhitelistMiddleware)
      .exclude(
        { path: 'api/v1/admin/health', method: RequestMethod.GET },
      )
      // Nest 10+ warns about legacy route wildcard syntax ('*').
      // '*path' keeps matching all admin routes while remaining path-to-regexp compatible.
      .forRoutes('*path')
  }
}

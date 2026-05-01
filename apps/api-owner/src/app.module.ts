// apps/owner-api/src/app.module.ts
// Root module for Owner API — only owner-relevant modules.
// Admin modules are NOT imported here — fully separate server.
// BullMQ: notifications, emails, sms, image-processing queues.
// JWT: OWNER_JWT_SECRET only — never shares secret with admin or player.

import { Module } from '@nestjs/common'
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { SentryModule } from '@sentry/nestjs/setup'

import { PrismaModule } from '@futsmandu/database'
import { RedisModule } from '@futsmandu/redis'
import { QueuesModule } from '@futsmandu/queues'

import { OwnerAuthModule }       from './modules/owner-auth/owner-auth.module.js'
import { VenueManagementModule } from './modules/venue-management/venue-management.module.js'
import { CourtsModule }          from './modules/courts/courts.module.js'
import { PricingModule }         from './modules/pricing/pricing.module.js'
import { BookingsModule }        from './modules/bookings/bookings.module.js'
import { AnalyticsModule }       from './modules/analytics/analytics.module.js'
import { StaffModule }           from './modules/staff/staff.module.js'
import { MediaModule }           from './modules/media/media.module.js'
import { NotificationsModule }   from './modules/notifications/notifications.module.js'
import { HealthModule }          from './modules/health/health.module.js'
import { OwnerPaymentModule } from './modules/owner-payment/owner-payment.module.js'
import { AbuseDetectionGuard } from './common/guards/abuse-detection.guard.js'
import { AuditModule, AuditInterceptor, AuditService } from '@futsmandu/audit'
import { ENV } from '@futsmandu/utils'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.owner', '../../.env', '.env'],
      cache: true,
    }),

    SentryModule.forRoot(),

    PrismaModule,
    RedisModule,
    AuditModule,

    // Owner JWT — 15m access, 30d refresh (Flutter Keychain/SecureStorage)
    // NOT global — imported only in OwnerAuthModule so the secret stays scoped
    JwtModule.register({
      global: true,
      secret: ENV['OWNER_JWT_SECRET'],
      signOptions: { expiresIn: '15m' },
    }),

    // Centralized BullMQ registration (prevents duplicate queue/worker instantiation)
    QueuesModule,

    // Stricter throttle for owner API — fewer calls, more critical
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),

    OwnerAuthModule,
    VenueManagementModule,
    CourtsModule,
    PricingModule,
    BookingsModule,
    AnalyticsModule,
    StaffModule,
    MediaModule,
    NotificationsModule,
    OwnerPaymentModule,
    HealthModule,
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
      provide: APP_GUARD,
      useClass: AbuseDetectionGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useFactory: (auditService: AuditService) => new AuditInterceptor(auditService, {
        actorType: 'OWNER',
        actorRole: 'OWNER_ADMIN',
        identityProperty: 'owner',
        urlNamespace: 'owner',
      }),
      inject: [AuditService],
    },
  ],
})
export class AppModule {}

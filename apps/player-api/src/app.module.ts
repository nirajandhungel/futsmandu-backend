// CHANGED: [M-4 — replaced inline BullModule registrations with QueuesModule]
// NEW ISSUES FOUND:
//   - BullModule.forRootAsync + BullModule.registerQueue were in AppModule AND duplicated
//     in individual feature modules, causing duplicate processor registrations

// apps/player-api/src/app.module.ts
// Root module — registers all feature modules and global infrastructure.
// @Global() modules (Prisma, Redis) registered once; no need to import elsewhere.
// QueuesModule owns all BullMQ queue registrations — feature modules import it.

import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'
import { ThrottlerModule } from '@nestjs/throttler'

import { PrismaModule } from '@futsmandu/database'
import { RedisModule } from '@futsmandu/redis'
import { QueuesModule } from '@futsmandu/queues'
import { AuthModule }        from './modules/auth/auth.module.js'
import { VenueModule }       from './modules/venue/venue.module.js'
import { BookingModule }     from './modules/booking/booking.module.js'
import { PaymentModule }     from './modules/payment/payment.module.js'
import { MatchModule }       from './modules/match/match.module.js'
import { FriendModule }      from './modules/friend/friend.module.js'
import { DiscoveryModule }   from './modules/discovery/discovery.module.js'
import { NotificationModule } from './modules/notification/notification.module.js'
import { ProfileModule }     from './modules/profile/profile.module.js'
import { HealthModule }      from './modules/health/health.module.js'
import { ENV } from '@futsmandu/utils'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
      cache: true,
    }),

    PrismaModule,
    RedisModule,

    JwtModule.register({
      global: true,
      secret: ENV['PLAYER_JWT_SECRET'],
      signOptions: { expiresIn: '15m' },
    }),

    // M-4: Single queue registration module — no duplicate registrations
    QueuesModule,

    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),

    AuthModule,
    VenueModule,
    BookingModule,
    PaymentModule,
    MatchModule,
    FriendModule,
    DiscoveryModule,
    NotificationModule,
    ProfileModule,
    HealthModule,
  ],
})
export class AppModule {}

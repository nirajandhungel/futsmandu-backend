# Futsmandu Backend

Nepal's first futsal community platform — NestJS 10 + Fastify adapter monorepo.

start redis: docker start -a futsmandu-redis
test docker:

$ docker exec -it futsmandu-redis redis-cli
127.0.0.1:6379> PING
PONG
127.0.0.1:6379> SET mykey "hello"
OK
127.0.0.1:6379> GETmykey
(error) ERR unknown command 'GETmykey', with args beginning with: 
127.0.0.1:6379> GET mykey
"hello"
127.0.0.1:6379> 


## Architecture

```
Internet
   ↓
NGINX (port 80)
   ├── /api/v1/player  → player-api:3001  (NestJS + Fastify, high traffic)
   ├── /api/v1/owner   → owner-admin-api:3002
   └── /api/v1/admin   → owner-admin-api:3002
        ↓
   Redis (cache + BullMQ queues)
        ↓
   PostgreSQL (Supabase)
        ↓
   Workers (BullMQ: notifications, refunds, slot-expiry, payment-recon, stats, email, sms)
```

## Why NestJS + Fastify Adapter?

- **NestJS** provides modular DI architecture, decorators, guards, interceptors, pipes — production-grade structure
- **Fastify adapter** replaces Express under the hood — ~30% higher req/s, lower latency under booking-hour spikes
- Best of both: NestJS scalability patterns + Fastify HTTP performance

## Monorepo Structure

```
FUTSMANDU-SERVER
├── apps
│   ├── admin-api
│   │   └── src
│   │       ├── common
│   │       │   ├── decorators
│   │       │   │   └── current-admin.decorator.ts
│   │       │   ├── filters
│   │       │   │   └── all-exceptions.filter.ts
│   │       │   ├── guards
│   │       │   │   ├── admin-jwt.guard.ts
│   │       │   │   └── roles.guard.ts
│   │       │   ├── interceptors
│   │       │   │   ├── audit.interceptor.ts
│   │       │   │   └── response.interceptor.ts
│   │       │   └── middleware
│   │       │       └── ip-whitelist.middleware.ts
│   │       ├── dto
│   │       │   └── media.dto.ts
│   │       ├── modules
│   │       │   ├── analytics
│   │       │   │   ├── analytics.controller.ts
│   │       │   │   ├── analytics.module.ts
│   │       │   │   └── analytics.service.ts
│   │       │   ├── auth
│   │       │   │   ├── dto
│   │       │   │   │   └── admin-auth.dto.ts
│   │       │   │   ├── auth.controller.ts
│   │       │   │   ├── auth.module.ts
│   │       │   │   └── auth.service.ts
│   │       │   ├── booking
│   │       │   │   ├── dto
│   │       │   │   │   └── booking.dto.ts
│   │       │   │   ├── admin-booking.controller.ts
│   │       │   │   ├── admin-booking.module.ts
│   │       │   │   └── admin-booking.service.ts
│   │       │   ├── health
│   │       │   │   ├── health.controller.ts
│   │       │   │   └── health.module.ts
│   │       │   ├── media
│   │       │   │   ├── media.controller.ts
│   │       │   │   └── media.module.ts
│   │       │   ├── payment
│   │       │   │   ├── dto
│   │       │   │   │   └── admin-payment.dto.ts
│   │       │   │   ├── payment.controller.ts
│   │       │   │   ├── payment.module.ts
│   │       │   │   └── payment.service.ts
│   │       │   ├── penalties
│   │       │   │   ├── penalties.controller.ts
│   │       │   │   ├── penalties.module.ts
│   │       │   │   └── penalties.service.ts
│   │       │   ├── players
│   │       │   │   ├── players.controller.ts
│   │       │   │   ├── players.module.ts
│   │       │   │   └── players.service.ts
│   │       │   ├── review-and-moderation
│   │       │   │   ├── admin-moderation.controller.ts
│   │       │   │   ├── admin-moderation.module.ts
│   │       │   │   └── admin-moderation.service.ts
│   │       │   └── venues
│   │       │       ├── admin-venues.controller.ts
│   │       │       ├── admin-venues.module.ts
│   │       │       └── admin-venues.service.ts
│   │       ├── scripts
│   │       │   ├── seed-admin.ts
│   │       │   └── seed-config.ts
│   │       ├── workers
│   │       │   ├── processors
│   │       │   │   └── email.processor.ts
│   │       │   ├── main.ts
│   │       │   └── worker.module.ts
│   │       ├── app.module.ts
│   │       ├── instrument.ts
│   │       └── main.ts
│   │   ├── nest-cli.json
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── owner-api
│   │   └── src
│   │       ├── common
│   │       │   ├── decorators
│   │       │   │   └── current-owner.decorator.ts
│   │       │   ├── filters
│   │       │   │   └── all-exceptions.filter.ts
│   │       │   ├── guards
│   │       │   │   ├── owner-jwt.guard.ts
│   │       │   │   └── roles.guard.ts
│   │       │   └── interceptors
│   │       │       └── response.interceptor.ts
│   │       ├── dto
│   │       │   └── media.dto.ts
│   │       ├── modules
│   │       │   ├── analytics
│   │       │   │   ├── analytics.controller.ts
│   │       │   │   ├── analytics.module.ts
│   │       │   │   └── analytics.service.ts
│   │       │   ├── bookings
│   │       │   │   ├── dto
│   │       │   │   │   └── booking.dto.ts
│   │       │   │   ├── bookings.controller.ts
│   │       │   │   ├── bookings.module.ts
│   │       │   │   └── bookings.service.ts
│   │       │   ├── courts
│   │       │   │   ├── courts.controller.ts
│   │       │   │   ├── courts.module.ts
│   │       │   │   └── courts.service.ts
│   │       │   ├── health
│   │       │   │   ├── health.controller.ts
│   │       │   │   └── health.module.ts
│   │       │   ├── media
│   │       │   │   ├── media.controller.ts
│   │       │   │   └── media.module.ts
│   │       │   ├── notifications
│   │       │   │   ├── notifications.module.ts
│   │       │   │   └── notifications.service.ts
│   │       │   ├── owner-auth
│   │       │   │   ├── dto
│   │       │   │   │   └── owner-auth.dto.ts
│   │       │   │   ├── owner-auth.controller.ts
│   │       │   │   ├── owner-auth.module.ts
│   │       │   │   └── owner-auth.service.ts
│   │       │   ├── owner-payment
│   │       │   │   ├── dto
│   │       │   │   │   └── owner-payment.dto.ts
│   │       │   │   ├── owner-payment.controller.ts
│   │       │   │   ├── owner-payment.module.ts
│   │       │   │   └── owner-payment.service.ts
│   │       │   ├── pricing
│   │       │   │   ├── dto
│   │       │   │   │   └── pricing.dto.ts
│   │       │   │   ├── pricing.controller.ts
│   │       │   │   ├── pricing.module.ts
│   │       │   │   └── pricing.service.ts
│   │       │   ├── staff
│   │       │   │   ├── dto
│   │       │   │   │   └── staff.dto.ts
│   │       │   │   ├── staff.controller.ts
│   │       │   │   ├── staff.module.ts
│   │       │   │   └── staff.service.ts
│   │       │   └── venue-management
│   │       │       ├── dto
│   │       │       │   └── venue.dto.ts
│   │       │       ├── venue-management.controller.ts
│   │       │       ├── venue-management.module.ts
│   │       │       └── venue-management.service.ts
│   │       ├── workers
│   │       │   ├── processors
│   │       │   │   ├── email.processor.ts
│   │       │   │   ├── notification.processor.ts
│   │       │   │   └── sms.processor.ts
│   │       │   ├── main.ts
│   │       │   └── worker.module.ts
│   │       ├── app.module.ts
│   │       ├── instrument.ts
│   │       └── main.ts
│   │   ├── nest-cli.json
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── player-api
│       └── src
│           ├── common
│           │   ├── decorators
│           │   │   └── index.ts
│           │   ├── filters
│           │   │   └── all-exceptions.filter.ts
│           │   ├── interceptors
│           │   │   └── response.interceptor.ts
│           │   └── pipes
│           │       └── sanitize.pipe.ts
│           ├── dto
│           │   └── media.dto.ts
│           ├── modules
│           │   ├── auth
│           │   │   ├── dto
│           │   │   │   └── auth.dto.ts
│           │   │   ├── auth.controller.ts
│           │   │   ├── auth.module.ts
│           │   │   └── auth.service.ts
│           │   ├── booking
│           │   │   ├── dto
│           │   │   │   └── booking.dto.ts
│           │   │   ├── booking-lifecycle.service.ts
│           │   │   ├── booking-match.service.ts
│           │   │   ├── booking.controller.ts
│           │   │   ├── booking.module.ts
│           │   │   └── booking.service.ts
│           │   ├── discovery
│           │   │   ├── discovery.controller.ts
│           │   │   ├── discovery.module.ts
│           │   │   └── discovery.service.ts
│           │   ├── friend
│           │   │   ├── friend.controller.ts
│           │   │   ├── friend.module.ts
│           │   │   └── friend.service.ts
│           │   ├── health
│           │   │   ├── health.controller.ts
│           │   │   └── health.module.ts
│           │   ├── match
│           │   │   ├── match.controller.ts
│           │   │   ├── match.module.ts
│           │   │   └── match.service.ts
│           │   ├── notification
│           │   │   ├── notification.controller.ts
│           │   │   ├── notification.module.ts
│           │   │   └── notification.service.ts
│           │   ├── payment
│           │   │   ├── dto
│           │   │   │   └── payment.dto.ts
│           │   │   ├── payment.controller.ts
│           │   │   ├── payment.module.ts
│           │   │   └── payment.service.ts
│           │   ├── profile
│           │   │   ├── profile.controller.ts
│           │   │   ├── profile.module.ts
│           │   │   └── profile.service.ts
│           │   └── venue
│           │       ├── venue.controller.ts
│           │       ├── venue.module.ts
│           │       └── venue.service.ts
│           ├── workers
│           │   ├── processors
│           │   │   ├── email.processor.ts
│           │   │   ├── media-orphan-cleanup.processor.ts
│           │   │   ├── notification.processor.ts
│           │   │   ├── owner-payout.processor.ts
│           │   │   ├── payment-recon.processor.ts
│           │   │   ├── payout-reconciler.processor.ts
│           │   │   ├── refund.processor.ts
│           │   │   ├── slot-expiry.processor.ts
│           │   │   ├── sms.processor.ts
│           │   │   └── stats.processor.ts
│           │   ├── main.ts
│           │   ├── scheduler.service.ts
│           │   └── worker.module.ts
│           ├── app.module.ts
│           ├── instrument.ts
│           └── main.ts
│       ├── nest-cli.json
│       ├── package.json
│       └── tsconfig.json
│
├── infrastructure
│
├── docker
│   ├── admin-api.Dockerfile
│   ├── admin-worker.Dockerfile
│   ├── owner-api.Dockerfile
│   ├── owner-worker.Dockerfile
│   ├── player.Dockerfile
│   └── worker.Dockerfile
│
├── nginx
│   ├── sites-available
│   │   └── futsmandu-routes.conf
│   ├── nginx.conf
│   └── proxy_params
│
├── packages
│   ├── auth
│   │   ├── src
│   │   │   ├── guards.ts
│   │   │   ├── index.ts
│   │   │   ├── jwt.strategy.ts
│   │   │   ├── otp.service.ts
│   │   │   ├── refresh-token.service.ts
│   │   │   ├── refresh-token.strategy.ts
│   │   │   ├── roles.decorator.ts
│   │   │   └── roles.guard.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── database
│   │   ├── generated
│   │   ├── prisma
│   │   │   ├── migrations
│   │   │   │   ├── 001_critical_indexes.sql
│   │   │   │   ├── 002_refresh_token_version.sql
│   │   │   │   ├── 003_admin_audit_log.sql
│   │   │   │   ├── 004_owner_fcm_token.sql
│   │   │   │   ├── 005_media_assets.sql
│   │   │   │   └── 006_flexible_bookings_match_join.sql
│   │   │   └── schema.prisma
│   │   ├── src
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── esewa-payout
│   │   ├── src
│   │   │   ├── esewa-payout.module.ts
│   │   │   ├── esewa-payout.service.ts
│   │   │   ├── index.ts
│   │   │   └── payout.service.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── logger
│   │   ├── src
│   │   │   ├── index.ts
│   │   │   └── logger.service.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── media
│   │   ├── src
│   │   │   ├── index.ts
│   │   │   ├── media.module.ts
│   │   │   ├── media.service.ts
│   │   │   └── storage.module.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── media-core
│   │   ├── src
│   │   │   ├── interfaces
│   │   │   ├── index.ts
│   │   │   └── media-key.util.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── media-processing
│   │   ├── src
│   │   │   ├── image-processing.processor.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── media-storage
│   │   ├── src
│   │   │   ├── index.ts
│   │   │   ├── storage.module.ts
│   │   │   └── storage.service.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── queues
│   │   ├── src
│   │   │   ├── index.ts
│   │   │   ├── queue.constants.ts
│   │   │   └── queues.module.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── redis
│   │   ├── src
│   │   │   ├── index.ts
│   │   │   ├── redis.module.ts
│   │   │   └── redis.service.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── sentry
│   │   ├── src
│   │   │   ├── capture.ts
│   │   │   ├── index.ts
│   │   │   └── init.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── types
│   │   ├── src
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── utils
│       ├── src
│       │   ├── env.config.ts
│       │   ├── helpers.ts
│       │   ├── index.ts
│       │   ├── notification-factory.ts
│       │   └── pricing-engine.ts
│       ├── package.json
│       └── tsconfig.json
│
├── scripts
│   ├── dev.sh
│   ├── migrate.sh
│   ├── validate-env.mjs
│   └── worker-health.mjs
│
├── .dockerignore
├── .env
├── .env.example
├── .gitignore
├── .npmrc
├── admin-api-testing-guide.md
├── admin-api.rest
├── backup.env
├── DOCKER_HANDOFF.md
├── docker-compose.yml
├── owner-api.rest
├── package.json
├── player-api-testing-guide.md
├── player-api.rest
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── README.md
├── seed-config.example.json
├── seed-config.local.json
├── tsconfig.base.json
├── tsconfig.json
└── turbo.json





## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Fill in all values in .env

# 3. Run database migrations + critical indexes
bash scripts/migrate.sh

# 4. Start everything with Docker Compose
docker compose -f infrastructure/docker-compose.yml up --build

# Player API:    http://localhost/api/v1/player
# Owner API:     http://localhost/api/v1/owner
# Health check:  http://localhost/health
# Swagger docs:  http://localhost:3001/api/docs  (dev only)
```

## Player API Modules

| Module | Routes | Key Logic |
|--------|--------|-----------|
| `auth` | POST /register, /login, /refresh, /logout, /forgot-password, /reset-password, /verify-email | JWT 15m + HTTP-only refresh cookie 7d, token rotation |
| `venue` | GET /venues, /venues/:id, POST /venues/:id/reviews | Full-text search, geo sorting |
| `booking` | GET /venues/:id/availability, POST /bookings/hold, GET /bookings, POST /bookings/:id/cancel | Advisory lock + SERIALIZABLE transaction, slot grid |
| `payment` | POST /payments/khalti-initiate, /khalti-verify, /esewa-initiate, /esewa-verify | Server-side amount validation, HMAC for eSewa |
| `match` | GET /matches/:id, POST /matches/:id/join, PUT /approve/:userId, POST /result, POST /invite-link | Match groups auto-created on booking confirmation |
| `discovery` | GET /matches/tonight, /tomorrow, /weekend, /open | 6-factor scoring, Redis cache per lat/lng grid |
| `friend` | GET /friends, POST /friends/request, PUT /friends/:id/accept, POST /friends/:id/block | Bidirectional graph, spam prevention |
| `profile` | GET /profile, PUT /profile, GET /profile/:userId, POST /profile/avatar | R2 presigned upload URL |
| `notification` | GET /notifications, PUT /notifications/read-all | In-app inbox + FCM push + SMS |
| `health` | GET /health | DB + Redis + queue status |

## Critical: Anti-Double-Booking

Two concurrency layers work together:

```
Layer 1: pg_try_advisory_xact_lock(hashtext('courtId:date:time'))
  → Non-blocking, returns false instantly if contended → clean 409
  → Scoped to transaction, auto-released on commit/rollback

Layer 2: Partial unique index (DB-level hard guarantee)
  CREATE UNIQUE INDEX idx_bookings_slot_lock
    ON bookings(court_id, booking_date, start_time)
    WHERE status IN ('HELD','PENDING_PAYMENT','CONFIRMED');
  → Cannot be bypassed by ANY application bug
  → EXPIRED/CANCELLED excluded → slot becomes available again
```

## Shared Packages Usage

```typescript
// In any module — just import, no boilerplate
import { PrismaService } from '@futsmandu/database'
import { RedisService }  from '@futsmandu/redis'
import { JwtAuthGuard, CurrentUser, Public } from '@futsmandu/auth'
import { calculatePrice, formatPaisa } from '@futsmandu/utils'
import type { GatewayVerification, SlotGridItem } from '@futsmandu/types'
```

## Environment Variables

See `.env.example` — all variables documented with descriptions.

## Scaling

```bash
# Scale Player API horizontally (NGINX round-robins across instances)
docker compose -f infrastructure/docker-compose.yml up --scale player-api=3

# Scale workers independently (based on queue depth)
docker compose -f infrastructure/docker-compose.yml up --scale worker=2
```

## Performance Targets

| Operation | P95 | Strategy |
|-----------|-----|----------|
| Slot availability grid | < 200ms | Composite index + Redis MGET (1 round-trip) |
| Booking hold | < 500ms | Advisory lock + SERIALIZABLE (short transaction) |
| Payment verification | < 2s | ReadCommitted + gateway API call |
| Discovery feed (cached) | < 50ms | Redis cache per lat/lng grid cell |
| Discovery feed (cold) | < 400ms | Partial index + Promise.all parallel queries |

## Security

- JWT access tokens: 15 minutes, in-memory on client
- Refresh tokens: 7 days, HTTP-only Secure cookie, rotated on every use
- Payment: server-side amount validation before every confirmation
- eSewa: HMAC-SHA256 signature verification (prevents tampered callbacks)
- Rate limiting: NGINX (coarse) + Upstash Ratelimit (fine-grained, per-user)
- Ban cache: Redis-backed on every authenticated request (no DB hit)
- RLS: Supabase row-level security on all user-data tables

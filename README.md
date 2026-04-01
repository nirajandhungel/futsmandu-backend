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
futsmandu-backend/
├── apps/
│   ├── player-api/          NestJS + Fastify — Player-facing (auth, bookings, payments, social, discovery)
│   └── owner-admin-api/     NestJS + Express — Owner/Admin (venue mgmt, analytics, moderation)
├── packages/
│   ├── database/            PrismaService + PrismaModule + schema.prisma (shared by both apps)
│   ├── redis/               RedisService (Upstash REST + ioredis for BullMQ)
│   ├── auth/                JwtStrategy + JwtAuthGuard + @CurrentUser() + @Public()
│   ├── logger/              AppLogger (structured JSON)
│   ├── types/               Shared TypeScript interfaces
│   └── utils/               Pricing engine, haversine, time helpers, NotificationFactory
├── infrastructure/
│   ├── nginx/               nginx.conf + proxy_params
│   ├── docker/              player.Dockerfile, worker.Dockerfile, owner.Dockerfile
│   └── docker-compose.yml   Full stack
└── scripts/
    ├── migrate.sh            Run Prisma migrations + critical indexes
    └── dev.sh                Start dev stack with hot-reload
```

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

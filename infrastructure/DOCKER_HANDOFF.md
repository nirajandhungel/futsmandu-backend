# Docker Handoff Guide (Frontend Testing)

This guide is for sharing ready-to-run backend containers/images with frontend developers.

## What is Dockerized

The stack has 8 services in `infrastructure/docker-compose.yml`:

- `nginx` (reverse proxy, entrypoint on `80/443`)
- `player-api` (public API, internal `3001`)
- `owner-api` (owner API, internal `3002`)
- `admin-api` (admin API, internal `3003`)
- `player-worker` (BullMQ jobs for player domain)
- `owner-worker` (BullMQ jobs for owner domain)
- `admin-worker` (BullMQ jobs for admin domain)
- `redis` (local/dev helper only; production should use Upstash)

## Important Fixes Applied

Infra issues were fixed so containers start correctly:

- Fixed all Docker `CMD` entrypoints to compiled Nest output:
  - `dist/apps/*/main.js`
  - `dist/apps/*/workers/main.js`
- Fixed `player-api` Docker healthcheck path:
  - from `/health`
  - to `/api/v1/player/health`

Without these fixes, containers could build but fail at runtime.

## Recommended Runtime for Frontend Team

For frontend integration testing, keep all services (including workers) running.

- They can call via Nginx:
  - `http://<host>/api/v1/player/...`
  - `http://<host>/api/v1/owner/...`
  - `http://<host>/api/v1/admin/...`
- Or direct API ports if you expose them separately.

## Option A: Share Source + Compose (simplest)

### 1) Prepare environment file

From repo root:

```bash
cp .env.example .env
nano .env
```

Fill in real values in `.env`. Do not commit `.env` (it is gitignored).

If you want the vars exported in your current shell (useful for debugging / ad-hoc commands):

```bash
set -a; source .env; set +a
```

### 2) Build and run

```bash
npm run docker:up
```

### 3) Verify

```bash
npm run docker:ps
npm run docker:logs
npm run nginx:test
```

### 4) Stop

```bash
npm run docker:down
```

## Production Runbook (do these in order)

From repo root:

### 0) One-time prerequisites

```bash
cp .env.example .env
nano .env
```

Optional export into current shell:

```bash
set -a; source .env; set +a
```

### 1) Pull base images

```bash
docker compose --env-file .env -f infrastructure/docker-compose.yml pull
```

### 2) Build the app images

Recommended (clean rebuild):

```bash
docker compose --env-file .env -f infrastructure/docker-compose.yml build --no-cache
```

### 3) Start / update the stack

```bash
docker compose --env-file .env -f infrastructure/docker-compose.yml up -d
```

### 4) Verify health

```bash
docker compose --env-file .env -f infrastructure/docker-compose.yml ps
docker compose --env-file .env -f infrastructure/docker-compose.yml logs -f --tail=200
docker exec -it futsmandu-nginx nginx -t
```

### 5) Reload nginx after config changes (no downtime)

```bash
docker exec -it futsmandu-nginx nginx -s reload
```

### 6) Stop / restart

```bash
docker compose --env-file .env -f infrastructure/docker-compose.yml down
docker compose --env-file .env -f infrastructure/docker-compose.yml restart
```

## Option B: Share Prebuilt Images (best for frontend handoff)

Build images once, then export tarballs and send them.

### 1) Build all images

```bash
npm run docker:build:retry
```

### 2) Export images

```bash
docker save -o futsmandu-images.tar \
  futsmandu-3-player-api \
  futsmandu-3-owner-api \
  futsmandu-3-admin-api \
  futsmandu-3-player-worker \
  futsmandu-3-owner-worker \
  futsmandu-3-admin-worker \
  nginx:1.25-alpine \
  redis:7.2-alpine
```

### 3) Frontend dev machine import

```bash
docker load -i futsmandu-images.tar
npm run docker:up
```

## DB + Prisma Fresh Start (when needed)

If you want a clean DB before handing off:

```bash
npm run prisma:generate
npm run prisma:migrate:deploy
```

For local dev reset flows, use your migration/dev workflow before container startup.

## Health Endpoints

- Player: `http://<host>/api/v1/player/health`
- Owner: `http://<host>/api/v1/owner/health`
- Admin: `http://<host>/api/v1/admin/health`
- Nginx: `http://<host>/nginx-health`

## Frontend Team Quick Commands

```bash
# start
npm run docker:up

# watch logs
npm run docker:logs

# validate nginx config
npm run nginx:test

# reload nginx config
npm run nginx:reload

# rebuild after backend changes
npm run docker:up

# cleanup
npm run docker:down
```

## Notes

- `redis` service in compose is for local/dev fallback; if Upstash is configured, app traffic uses Upstash.
- `deploy.resources` in compose is mostly for Docker Swarm; local Docker Compose may ignore those limits.
- Keep `.env` aligned across the team to avoid startup drift.
- If Docker build fails with `npm ci ... ETIMEDOUT`, it is a network timeout to npm registry during image build. Re-run `npm run docker:build:retry` or use a stable network/VPN.

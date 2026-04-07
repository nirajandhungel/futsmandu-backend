# infrastructure/docker/owner-worker.Dockerfile
# Owner BullMQ worker — same build as owner-api, different CMD.
# Processes: notifications (FCM), emails (Resend), sms (Sparrow), image-processing (Sharp).
# No HTTP port exposed — workers only make outbound connections.

FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
COPY tsconfig.base.json ./

COPY packages/database/package.json  ./packages/database/
COPY packages/redis/package.json     ./packages/redis/
COPY packages/auth/package.json      ./packages/auth/
COPY packages/logger/package.json    ./packages/logger/
COPY packages/media/package.json     ./packages/media/
COPY packages/types/package.json     ./packages/types/
COPY packages/utils/package.json     ./packages/utils/
COPY apps/owner-api/package.json     ./apps/owner-api/

RUN npm ci \
    --workspace=apps/owner-api \
    --workspace=packages/database \
    --workspace=packages/redis \
    --workspace=packages/auth \
    --workspace=packages/logger \
    --workspace=packages/media \
    --workspace=packages/types \
    --workspace=packages/utils \
    --include-workspace-root \
    --frozen-lockfile

COPY packages/database/prisma ./packages/database/prisma/
RUN npx prisma generate --schema=packages/database/prisma/schema.prisma

COPY packages/ ./packages/
COPY apps/owner-api/ ./apps/owner-api/

# No || true — build failures must be loud.
RUN npm run build --workspace=packages/types
RUN npm run build --workspace=packages/logger
RUN npm run build --workspace=packages/media
RUN npm run build --workspace=packages/redis
RUN npm run build --workspace=packages/database
RUN npm run build --workspace=packages/auth
RUN npm run build --workspace=packages/utils
RUN npm run build --workspace=apps/owner-api

RUN npm prune --production

# ── Production image ──────────────────────────────────────────────────────────
FROM node:22-alpine AS production

# vips  — Sharp runtime library (image processing).
# fftw  — Fast Fourier Transform, required by libvips for certain operations.
# Note: vips-dev (headers) is NOT needed at runtime — that is a builder-only concern.
RUN apk add --no-cache vips fftw

RUN addgroup -g 1001 -S nodejs && adduser -S owner-worker -u 1001

WORKDIR /app

# Copy compiled output and production node_modules from builder.
# packages/ already contains packages/database/generated — no need to copy it twice.
COPY --from=builder --chown=owner-worker:nodejs /app/dist         ./dist
COPY --from=builder --chown=owner-worker:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=owner-worker:nodejs /app/packages     ./packages
COPY --from=builder --chown=owner-worker:nodejs /app/package.json ./

# Copy the health check script.
# Uses a raw TCP connect to REDIS_URL — no ioredis require() needed, no CWD issues.
COPY --chown=owner-worker:nodejs scripts/worker-health.mjs ./scripts/worker-health.mjs

USER owner-worker

# Workers have no HTTP port — health is checked by probing Redis reachability.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node /app/scripts/worker-health.mjs

# Run the owner worker process (not the HTTP API)
CMD ["node", "dist/apps/owner-api/workers/main.js"]

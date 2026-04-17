# infrastructure/docker/owner-api.Dockerfile
# Owner API — NestJS + Fastify + @fastify/multipart + Sharp (native bindings)
# Multi-stage build: builder compiles TS, production stage runs minimal image.
# Sharp requires python3/make/g++ for native module compilation in builder stage.
#
# Compiled output lands in: apps/api-owner/dist/main.js

FROM node:22-alpine AS builder

# Sharp native bindings require build tools
RUN apk add --no-cache python3 make g++

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY tsconfig.base.json ./

COPY packages/types/package.json            ./packages/types/
COPY packages/utils/package.json            ./packages/utils/
COPY packages/logger/package.json           ./packages/logger/
COPY packages/redis/package.json            ./packages/redis/
COPY packages/queues/package.json           ./packages/queues/
COPY packages/database/package.json         ./packages/database/
COPY packages/media-core/package.json       ./packages/media-core/
COPY packages/media-storage/package.json    ./packages/media-storage/
COPY packages/media-processing/package.json ./packages/media-processing/
COPY packages/media/package.json            ./packages/media/
COPY packages/auth/package.json             ./packages/auth/
COPY packages/sentry/package.json           ./packages/sentry/
COPY packages/esewa-payout/package.json     ./packages/esewa-payout/
COPY apps/api-owner/package.json            ./apps/api-owner/

RUN pnpm install --frozen-lockfile

COPY packages/database/prisma ./packages/database/prisma/
RUN pnpm --filter @futsmandu/database exec prisma generate --schema=prisma/schema.prisma

COPY packages/ ./packages/
COPY apps/api-owner/ ./apps/api-owner/

# No || true — build failures must be loud.
RUN pnpm --filter @futsmandu/types run build
RUN pnpm --filter @futsmandu/utils run build
RUN pnpm --filter @futsmandu/logger run build
RUN pnpm --filter @futsmandu/redis run build
RUN pnpm --filter @futsmandu/queues run build
RUN pnpm --filter @futsmandu/database run build
RUN pnpm --filter @futsmandu/media-core run build
RUN pnpm --filter @futsmandu/media-storage run build
RUN pnpm --filter @futsmandu/media-processing run build
RUN pnpm --filter @futsmandu/media run build
RUN pnpm --filter @futsmandu/auth run build
RUN pnpm --filter @futsmandu/sentry run build
RUN pnpm --filter @futsmandu/esewa-payout run build
RUN pnpm --filter @futsmandu/owner-api run build

RUN pnpm prune --prod

# ── Production image ──────────────────────────────────────────────────────────
FROM node:22-alpine AS production

# vips  — Sharp runtime library (image processing).
# fftw  — Fast Fourier Transform, required by libvips for certain operations.
# wget  — used by Docker HEALTHCHECK.
RUN apk add --no-cache vips fftw wget

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S owner-api -u 1001

WORKDIR /app

COPY --from=builder --chown=owner-api:nodejs /app/node_modules    ./node_modules
COPY --from=builder --chown=owner-api:nodejs /app/packages        ./packages
COPY --from=builder --chown=owner-api:nodejs /app/apps/api-owner  ./apps/api-owner
COPY --from=builder --chown=owner-api:nodejs /app/package.json    ./

USER owner-api

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3002/api/v1/owner/health || exit 1

CMD ["node", "apps/api-owner/dist/main.js"]

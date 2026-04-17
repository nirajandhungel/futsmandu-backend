# infrastructure/docker/player.Dockerfile
# Multi-stage build for the Player API (NestJS + Fastify adapter).
# Stage 1 (builder): installs all deps via pnpm, generates Prisma client, compiles TypeScript.
# Stage 2 (production): lean runtime image — no TypeScript compiler, no source maps, no dev tools.
#
# Compiled output lands in: apps/api-player/dist/main.js  (outDir: "dist" in app tsconfig)

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

# python3/make/g++ required for native modules (sharp, bufferutil, etc.)
RUN apk add --no-cache python3 make g++

# Install pnpm (must match packageManager in root package.json)
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Copy workspace manifests — maximises Docker layer cache.
# Reinstall only when these change, not on every source code edit.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY tsconfig.base.json ./

# Copy each package manifest before source (layer cache optimisation)
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
COPY apps/api-player/package.json           ./apps/api-player/

# Install deps for player-api and all its workspace dependencies (frozen from pnpm-lock.yaml)
RUN pnpm install --frozen-lockfile

# Generate Prisma client BEFORE TypeScript compilation.
COPY packages/database/prisma ./packages/database/prisma/
RUN pnpm --filter @futsmandu/database exec prisma generate --schema=prisma/schema.prisma

# Copy all source code after deps are installed and Prisma is generated.
COPY packages/ ./packages/
COPY apps/api-player/ ./apps/api-player/

# Build shared packages in dependency order, then the app.
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
RUN pnpm --filter @futsmandu/player-api run build

# Strip devDependencies — reduces final image size significantly
RUN pnpm prune --prod

# ── Stage 2: Production Runtime ───────────────────────────────────────────────
FROM node:22-alpine AS production

RUN apk add --no-cache wget

RUN addgroup -g 1001 -S nodejs && adduser -S nestjs -u 1001

WORKDIR /app

# Copy compiled output and production node_modules from builder.
COPY --from=builder --chown=nestjs:nodejs /app/node_modules      ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/packages          ./packages
COPY --from=builder --chown=nestjs:nodejs /app/apps/api-player   ./apps/api-player
COPY --from=builder --chown=nestjs:nodejs /app/package.json      ./

USER nestjs

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/v1/player/health || exit 1

# dist/main.js is relative to the app dir — run from repo root using full path
CMD ["node", "apps/api-player/dist/main.js"]

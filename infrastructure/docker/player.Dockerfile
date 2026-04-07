# infrastructure/docker/player.Dockerfile
# Multi-stage build for the Player API (NestJS + Fastify adapter).
# Stage 1 (builder): installs all deps, generates Prisma client, compiles TypeScript.
# Stage 2 (production): lean runtime image — no TypeScript compiler, no source maps, no dev tools.

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

# python3/make/g++ required for native modules (bcrypt, bufferutil, etc.)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy workspace root manifest files first — maximises Docker layer cache.
# These layers are only invalidated when package.json or tsconfig changes.
COPY package*.json ./
COPY tsconfig.base.json ./

# Copy each workspace package manifest (needed for npm workspaces resolution).
# Source code is NOT copied here — keeps the npm ci layer cached across code changes.
COPY packages/database/package.json  ./packages/database/
COPY packages/redis/package.json     ./packages/redis/
COPY packages/auth/package.json      ./packages/auth/
COPY packages/logger/package.json    ./packages/logger/
COPY packages/media/package.json     ./packages/media/
COPY packages/types/package.json     ./packages/types/
COPY packages/utils/package.json     ./packages/utils/
COPY apps/player-api/package.json    ./apps/player-api/

# Install ONLY workspaces needed for player-api.
# Skips owner-admin-api entirely — no express/passport-local/etc in this image.
# --include-workspace-root adds root devDependencies (TypeScript compiler).
RUN npm ci \
    --workspace=apps/player-api \
    --workspace=packages/database \
    --workspace=packages/redis \
    --workspace=packages/auth \
    --workspace=packages/logger \
    --workspace=packages/media \
    --workspace=packages/types \
    --workspace=packages/utils \
    --include-workspace-root \
    --frozen-lockfile

# Generate Prisma client BEFORE TypeScript compilation.
# Prisma codegen must happen first so @prisma/client types exist for tsc.
COPY packages/database/prisma ./packages/database/prisma/
RUN npx prisma generate --schema=packages/database/prisma/schema.prisma

# Copy all source code after deps are installed and Prisma is generated.
COPY packages/ ./packages/
COPY apps/player-api/ ./apps/player-api/

# Build shared packages in dependency order.
# No || true — build failures must be loud. A silently broken package
# produces a broken runtime image that is harder to debug than a build failure.
RUN npm run build --workspace=packages/types
RUN npm run build --workspace=packages/logger
RUN npm run build --workspace=packages/media
RUN npm run build --workspace=packages/redis
RUN npm run build --workspace=packages/database
RUN npm run build --workspace=packages/auth
RUN npm run build --workspace=packages/utils

# Build player-api
RUN npm run build --workspace=apps/player-api

# Strip devDependencies — reduces final image size significantly
RUN npm prune --production

# ── Stage 2: Production Runtime ───────────────────────────────────────────────
FROM node:22-alpine AS production

RUN apk add --no-cache wget

RUN addgroup -g 1001 -S nodejs && adduser -S nestjs -u 1001

WORKDIR /app

# Copy compiled output and production node_modules from builder.
# packages/ already contains packages/database/generated — no need to copy it twice.
COPY --from=builder --chown=nestjs:nodejs /app/dist         ./dist
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/packages     ./packages
COPY --from=builder --chown=nestjs:nodejs /app/package.json ./

USER nestjs

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/v1/player/health || exit 1

CMD ["node", "dist/apps/player-api/main.js"]

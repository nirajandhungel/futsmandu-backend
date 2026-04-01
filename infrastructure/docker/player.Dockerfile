# infrastructure/docker/player.Dockerfile
# Multi-stage build for the Player API (NestJS + Fastify adapter).
# Stage 1 (builder): installs all deps, generates Prisma client, compiles TypeScript.
# Stage 2 (production): lean runtime image — no TypeScript compiler, no source maps, no dev tools.

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy workspace root files first for layer caching
COPY package*.json ./
COPY tsconfig.base.json ./

# Copy all package manifests (needed for workspace resolution)
COPY packages/database/package.json  ./packages/database/
COPY packages/redis/package.json     ./packages/redis/
COPY packages/auth/package.json      ./packages/auth/
COPY packages/logger/package.json    ./packages/logger/
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
    --workspace=packages/types \
    --workspace=packages/utils \
    --include-workspace-root \
    --frozen-lockfile

# Copy Prisma schema and generate client BEFORE TypeScript compilation
COPY packages/database/prisma ./packages/database/prisma/
RUN npx prisma generate --schema=packages/database/prisma/schema.prisma

# Copy all source code
COPY packages/ ./packages/
COPY apps/player-api/ ./apps/player-api/

# Build shared packages first (player-api depends on them)
RUN npm run build --workspace=packages/types   || true
RUN npm run build --workspace=packages/logger  || true
RUN npm run build --workspace=packages/redis   || true
RUN npm run build --workspace=packages/database || true
RUN npm run build --workspace=packages/auth    || true
RUN npm run build --workspace=packages/utils   || true

# Build player-api
RUN npm run build --workspace=apps/player-api

# Prune dev dependencies for production stage
RUN npm prune --production

# ── Stage 2: Production Runtime ───────────────────────────────────────────────
FROM node:20-alpine AS production

RUN apk add --no-cache wget

RUN addgroup -g 1001 -S nodejs && adduser -S nestjs -u 1001

WORKDIR /app

# Copy only what's needed to run
COPY --from=builder --chown=nestjs:nodejs /app/dist                    ./dist
COPY --from=builder --chown=nestjs:nodejs /app/node_modules            ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/packages                ./packages
COPY --from=builder --chown=nestjs:nodejs /app/packages/database/prisma ./packages/database/prisma
COPY --from=builder --chown=nestjs:nodejs /app/packages/database/generated ./packages/database/generated
COPY --from=builder --chown=nestjs:nodejs /app/package.json            ./

USER nestjs

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/v1/player/health || exit 1

# Start the compiled NestJS API
CMD ["node", "dist/apps/player-api/main.js"]

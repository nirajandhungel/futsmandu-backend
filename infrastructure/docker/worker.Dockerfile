# infrastructure/docker/worker.Dockerfile
# BullMQ worker container — same build as player API, different CMD.
# Workers are stateless and scale independently of the API containers.

FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
COPY tsconfig.base.json ./

COPY packages/database/package.json  ./packages/database/
COPY packages/redis/package.json     ./packages/redis/
COPY packages/auth/package.json      ./packages/auth/
COPY packages/logger/package.json    ./packages/logger/
COPY packages/types/package.json     ./packages/types/
COPY packages/utils/package.json     ./packages/utils/
COPY apps/player-api/package.json    ./apps/player-api/

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

COPY packages/database/prisma ./packages/database/prisma/
RUN npx prisma generate --schema=packages/database/prisma/schema.prisma

COPY packages/ ./packages/
COPY apps/player-api/ ./apps/player-api/

# No || true — build failures must be loud.
RUN npm run build --workspace=packages/types
RUN npm run build --workspace=packages/logger
RUN npm run build --workspace=packages/redis
RUN npm run build --workspace=packages/database
RUN npm run build --workspace=packages/auth
RUN npm run build --workspace=packages/utils
RUN npm run build --workspace=apps/player-api

RUN npm prune --production

FROM node:22-alpine AS production

RUN addgroup -g 1001 -S nodejs && adduser -S worker -u 1001

WORKDIR /app

# Copy compiled output and production node_modules from builder.
# packages/ already contains packages/database/generated — no need to copy it twice.
COPY --from=builder --chown=worker:nodejs /app/dist         ./dist
COPY --from=builder --chown=worker:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=worker:nodejs /app/packages     ./packages
COPY --from=builder --chown=worker:nodejs /app/package.json ./

# Copy the health check script.
# Uses a raw TCP connect to REDIS_URL — no ioredis require() needed, no CWD issues.
# See scripts/worker-health.mjs for implementation details.
COPY --chown=worker:nodejs scripts/worker-health.mjs ./scripts/worker-health.mjs

USER worker

# Workers have no HTTP port — health is checked by probing Redis reachability.
# The script is dependency-free (Node built-ins only) so it works regardless of
# how node_modules are laid out inside the container.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node /app/scripts/worker-health.mjs

# Run the worker process (not the API)
CMD ["node", "dist/apps/player-api/workers/main.js"]

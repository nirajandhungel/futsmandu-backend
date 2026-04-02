# infrastructure/docker/admin-worker.Dockerfile
# Admin BullMQ worker — processes emails and admin-alerts queues.
# Very lightweight — no image processing, no FCM, no SMS.

FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig.base.json ./

COPY packages/database/package.json  ./packages/database/
COPY packages/redis/package.json     ./packages/redis/
COPY packages/auth/package.json      ./packages/auth/
COPY packages/logger/package.json    ./packages/logger/
COPY packages/types/package.json     ./packages/types/
COPY packages/utils/package.json     ./packages/utils/
COPY apps/admin-api/package.json     ./apps/admin-api/

RUN npm ci \
    --workspace=apps/admin-api \
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
COPY apps/admin-api/ ./apps/admin-api/

# No || true — build failures must be loud.
RUN npm run build --workspace=packages/types
RUN npm run build --workspace=packages/logger
RUN npm run build --workspace=packages/redis
RUN npm run build --workspace=packages/database
RUN npm run build --workspace=packages/auth
RUN npm run build --workspace=packages/utils
RUN npm run build --workspace=apps/admin-api

RUN npm prune --production

FROM node:22-alpine AS production

RUN addgroup -g 1001 -S nodejs && adduser -S admin-worker -u 1001

WORKDIR /app

# Copy compiled output and production node_modules from builder.
# packages/ already contains packages/database/generated — no need to copy it twice.
COPY --from=builder --chown=admin-worker:nodejs /app/dist         ./dist
COPY --from=builder --chown=admin-worker:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=admin-worker:nodejs /app/packages     ./packages
COPY --from=builder --chown=admin-worker:nodejs /app/package.json ./

# Copy the health check script.
# Uses a raw TCP connect to REDIS_URL — no ioredis require() needed, no CWD issues.
COPY --chown=admin-worker:nodejs scripts/worker-health.mjs ./scripts/worker-health.mjs

USER admin-worker

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node /app/scripts/worker-health.mjs

CMD ["node", "dist/apps/admin-api/workers/main.js"]

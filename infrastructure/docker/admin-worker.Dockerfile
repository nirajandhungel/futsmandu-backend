# infrastructure/docker/admin-worker.Dockerfile
# Admin BullMQ worker — processes emails and admin-alerts queues.
# Very lightweight — no image processing, no FCM, no SMS.
#
# Compiled output lands in: apps/api-admin/dist/workers/main.js

FROM node:22-alpine AS builder

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
COPY apps/api-admin/package.json            ./apps/api-admin/

RUN pnpm install --frozen-lockfile

COPY packages/database/prisma ./packages/database/prisma/
RUN pnpm --filter @futsmandu/database exec prisma generate --schema=prisma/schema.prisma

COPY packages/ ./packages/
COPY apps/api-admin/ ./apps/api-admin/

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
RUN pnpm --filter @futsmandu/admin-api run build

RUN pnpm prune --prod

FROM node:22-alpine AS production

RUN addgroup -g 1001 -S nodejs && adduser -S admin-worker -u 1001

WORKDIR /app

COPY --from=builder --chown=admin-worker:nodejs /app/node_modules   ./node_modules
COPY --from=builder --chown=admin-worker:nodejs /app/packages       ./packages
COPY --from=builder --chown=admin-worker:nodejs /app/apps/api-admin ./apps/api-admin
COPY --from=builder --chown=admin-worker:nodejs /app/package.json   ./

COPY --chown=admin-worker:nodejs scripts/worker-health.mjs ./scripts/worker-health.mjs

USER admin-worker

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node /app/scripts/worker-health.mjs

CMD ["node", "apps/api-admin/dist/workers/main.js"]

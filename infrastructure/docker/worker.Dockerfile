# infrastructure/docker/worker.Dockerfile
# BullMQ worker container — same build as player API, different CMD.
# Workers are stateless and scale independently of the API containers.

FROM node:20-alpine AS builder

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

RUN npm run build --workspace=packages/types   || true
RUN npm run build --workspace=packages/logger  || true
RUN npm run build --workspace=packages/redis   || true
RUN npm run build --workspace=packages/database || true
RUN npm run build --workspace=packages/auth    || true
RUN npm run build --workspace=packages/utils   || true
RUN npm run build --workspace=apps/player-api

RUN npm prune --production

FROM node:20-alpine AS production

RUN addgroup -g 1001 -S nodejs && adduser -S worker -u 1001

WORKDIR /app

COPY --from=builder --chown=worker:nodejs /app/dist                    ./dist
COPY --from=builder --chown=worker:nodejs /app/node_modules            ./node_modules
COPY --from=builder --chown=worker:nodejs /app/packages                ./packages
COPY --from=builder --chown=worker:nodejs /app/packages/database/prisma ./packages/database/prisma
COPY --from=builder --chown=worker:nodejs /app/packages/database/generated ./packages/database/generated
COPY --from=builder --chown=worker:nodejs /app/package.json            ./

USER worker

# Workers have no HTTP port — outbound connections only (Redis + DB + external APIs)
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "const Redis=require('ioredis'); const url=process.env.REDIS_URL || process.env.UPSTASH_REDIS_IOREDIS_URL || ('redis://:' + (process.env.REDIS_PASSWORD || 'localdevredis') + '@redis:6379'); const opts=/^rediss:\\/\\//.test(url) ? {tls:{rejectUnauthorized:false}} : {}; new Redis(url,opts).ping().then(()=>process.exit(0)).catch(()=>process.exit(1))"

# Run the worker process (not the API)
CMD ["node", "dist/apps/player-api/workers/main.js"]

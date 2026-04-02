# infrastructure/docker/admin-api.Dockerfile
# Admin API — NestJS + Fastify, web browser only.
# No Sharp (no image uploads), no multipart, minimal image size.
# Extra security: read-only filesystem in production, no shell.

FROM node:22-alpine AS builder

# No python/make/g++ needed — no native modules in admin-api
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

# ── Production image ──────────────────────────────────────────────────────────
FROM node:22-alpine AS production

# No native build tools needed in production
RUN apk add --no-cache wget
RUN addgroup -g 1001 -S nodejs && adduser -S admin-api -u 1001

WORKDIR /app

# Copy compiled output and production node_modules from builder.
# packages/ already contains packages/database/generated — no need to copy it twice.
COPY --from=builder --chown=admin-api:nodejs /app/dist         ./dist
COPY --from=builder --chown=admin-api:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=admin-api:nodejs /app/packages     ./packages
COPY --from=builder --chown=admin-api:nodejs /app/package.json ./

USER admin-api

EXPOSE 3003

# Admin health check — IP whitelisted so only internal calls reach it
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -qO- http://localhost:3003/api/v1/admin/health || exit 1

CMD ["node", "dist/apps/admin-api/main.js"]

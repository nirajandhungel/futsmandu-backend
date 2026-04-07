# infrastructure/docker/owner-api.Dockerfile
# Owner API — NestJS + Fastify + @fastify/multipart + Sharp (native bindings)
# Multi-stage build: builder compiles TS, production stage runs minimal image.
# Sharp requires python3/make/g++ for native module compilation in builder stage.

FROM node:22-alpine AS builder

# Sharp native bindings require build tools
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy root workspace manifests first (layer cache — reinstall only when deps change)
COPY package*.json ./
COPY tsconfig.base.json ./

# Copy each package manifest before source (maximises Docker layer cache hits)
COPY packages/database/package.json  ./packages/database/
COPY packages/redis/package.json     ./packages/redis/
COPY packages/auth/package.json      ./packages/auth/
COPY packages/logger/package.json    ./packages/logger/
COPY packages/media/package.json     ./packages/media/
COPY packages/types/package.json     ./packages/types/
COPY packages/utils/package.json     ./packages/utils/
COPY apps/owner-api/package.json     ./apps/owner-api/

# Install all workspace deps including devDependencies (needed for tsc)
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

# Generate Prisma client (must happen before TS compilation)
COPY packages/database/prisma ./packages/database/prisma/
RUN npx prisma generate --schema=packages/database/prisma/schema.prisma

# Copy all source files
COPY packages/ ./packages/
COPY apps/owner-api/ ./apps/owner-api/

# Build packages in dependency order, then the app.
# No || true — build failures must be loud. A silently broken package
# produces a broken runtime image that is harder to debug than a build failure.
RUN npm run build --workspace=packages/types
RUN npm run build --workspace=packages/logger
RUN npm run build --workspace=packages/media
RUN npm run build --workspace=packages/redis
RUN npm run build --workspace=packages/database
RUN npm run build --workspace=packages/auth
RUN npm run build --workspace=packages/utils
RUN npm run build --workspace=apps/owner-api

# Prune dev dependencies for production image
RUN npm prune --production

# ── Production image ──────────────────────────────────────────────────────────
FROM node:22-alpine AS production

# vips  — Sharp runtime library (image processing).
# fftw  — Fast Fourier Transform, required by libvips for certain operations.
# wget  — used by Docker HEALTHCHECK.
# Note: vips-dev (headers) is NOT needed at runtime — that is a builder-only concern.
RUN apk add --no-cache vips fftw wget

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S owner-api -u 1001

WORKDIR /app

# Copy compiled output and production node_modules from builder.
# packages/ already contains packages/database/generated — no need to copy it twice.
COPY --from=builder --chown=owner-api:nodejs /app/dist         ./dist
COPY --from=builder --chown=owner-api:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=owner-api:nodejs /app/packages     ./packages
COPY --from=builder --chown=owner-api:nodejs /app/package.json ./

USER owner-api

EXPOSE 3002

# Health check — Docker restarts container if API stops responding
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -qO- http://localhost:3002/api/v1/owner/health || exit 1

CMD ["node", "dist/apps/owner-api/main.js"]

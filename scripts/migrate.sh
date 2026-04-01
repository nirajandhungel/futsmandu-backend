#!/usr/bin/env bash
# scripts/migrate.sh
# Run Prisma migrations against the database.
# Uses DIRECT_DATABASE_URL (not PgBouncer pooled) — required for DDL.
# Then applies critical custom indexes that Prisma cannot express natively.
#
# Usage:
#   bash scripts/migrate.sh            # apply pending migrations
#   bash scripts/migrate.sh --reset    # DANGER: reset database (dev only)

set -euo pipefail

SCHEMA="packages/database/prisma/schema.prisma"
INDEXES_SQL="packages/database/prisma/migrations/001_critical_indexes.sql"

if [ ! -f ".env" ]; then
  echo "❌  .env not found. Copy .env.example → .env and fill in values."
  exit 1
fi

# Load env
set -a; source .env; set +a

if [ -z "${DIRECT_DATABASE_URL:-}" ]; then
  echo "❌  DIRECT_DATABASE_URL is not set in .env"
  exit 1
fi

# Optional reset (dev only)
if [ "${1:-}" = "--reset" ]; then
  if [ "${NODE_ENV:-}" = "production" ]; then
    echo "❌  --reset is not allowed in production"
    exit 1
  fi
  echo "⚠️  Resetting database (dev only)..."
  npx prisma migrate reset --force --schema="$SCHEMA"
fi

echo "▶  Running Prisma migrations..."
DATABASE_URL="$DIRECT_DATABASE_URL" npx prisma migrate deploy --schema="$SCHEMA"

echo "▶  Applying critical custom indexes and RLS policies..."
psql "$DIRECT_DATABASE_URL" -f "$INDEXES_SQL"

echo "▶  Generating Prisma client..."
npx prisma generate --schema="$SCHEMA"

echo "✅  Migration complete."

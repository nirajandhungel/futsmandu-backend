#!/usr/bin/env bash
# scripts/dev.sh
# Start the full development stack with hot-reload.
# Requires: Node 20+, Docker (for local Redis + Postgres), tmux or separate terminals.
#
# Usage:
#   bash scripts/dev.sh             # start everything in background
#   bash scripts/dev.sh player      # player API only
#   bash scripts/dev.sh worker      # BullMQ workers only

set -euo pipefail

if [ ! -f ".env" ]; then
  echo "❌  .env not found. Copy .env.example → .env"
  exit 1
fi

MODE="${1:-all}"

echo "▶  Installing workspace dependencies..."
npm install

echo "▶  Generating Prisma client..."
npx prisma generate --schema=packages/database/prisma/schema.prisma

case "$MODE" in
  player)
    echo "▶  Starting Player API (hot-reload)..."
    npm run dev:player
    ;;
  worker)
    echo "▶  Starting BullMQ workers (hot-reload)..."
    npm run dev:worker
    ;;
  all | *)
    echo "▶  Starting Player API + Worker (parallel)..."
    # Requires GNU parallel or run in separate terminals
    npm run dev:player &
    PID_API=$!
    sleep 3
    npm run dev:worker &
    PID_WORKER=$!
    echo "Player API PID: $PID_API  |  Worker PID: $PID_WORKER"
    echo "Press Ctrl+C to stop all."
    wait
    ;;
esac

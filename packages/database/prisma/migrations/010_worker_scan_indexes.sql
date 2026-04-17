-- packages/database/prisma/migrations/010_worker_scan_indexes.sql
-- Worker scan performance indexes (cursor-friendly).
--
-- Run with:
--   psql $DIRECT_DATABASE_URL -f packages/database/prisma/migrations/010_worker_scan_indexes.sql
--
-- Uses CONCURRENTLY to avoid locking large tables.
-- NOTE: CONCURRENTLY cannot run inside a transaction block.

-- Slot-expiry + payment-recon workers
-- Query shape:
--   WHERE status IN ('HELD','PENDING_PAYMENT') AND hold_expires_at <= now()
--   ORDER BY hold_expires_at ASC, id ASC
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_hold_expiry_cursor
  ON bookings (hold_expires_at ASC, id ASC)
  WHERE status IN ('HELD', 'PENDING_PAYMENT') AND hold_expires_at IS NOT NULL;

-- Payout-reconciler worker
-- Query shape:
--   WHERE status='PENDING' AND created_at <= cutoff
--     AND (last_attempted_at IS NULL OR last_attempted_at <= cutoff)
--   ORDER BY created_at ASC, id ASC
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_owner_payouts_pending_retry_scan
  ON owner_payouts (created_at ASC, last_attempted_at ASC, id ASC)
  WHERE status = 'PENDING';


-- packages/database/prisma/migrations/007_media_orphan_cleanup_index.sql
-- Optimizes the media-orphan-cleanup job query performance.
--
-- The cleanup processor scans for:
--   WHERE status = 'processing' AND updated_at < cutoff
--   ORDER BY updated_at ASC
--
-- This composite index makes that query much faster, especially on tables with
-- many assets. The DESC on updated_at helps the sort order.

CREATE INDEX IF NOT EXISTS "media_assets_status_updated_idx"
  ON "media_assets" ("status", "updated_at" DESC)
  WHERE "status" = 'processing';

-- Optional but useful for ops: query all stuck jobs across all statuses
CREATE INDEX IF NOT EXISTS "media_assets_updated_idx"
  ON "media_assets" ("updated_at" DESC)
  WHERE "status" IN ('processing', 'failed');

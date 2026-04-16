-- packages/database/prisma/migrations/008_media_optimizations.sql
--
-- Media performance optimizations:
--   1. Index on (entity_id, status) for gallery queries — was only (entity_id, asset_type)
--   2. Index on (id, uploader_id) for status polling — avoids full table scan per poll
--   3. Partial index: only index non-ready assets for polling (ready assets rarely polled)
--   4. thumb_key column index — used in gallery batch presigning

-- Fast status polling: /status/:assetId?ownerId= queries both id and uploader_id
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_media_assets_id_uploader
  ON media_assets (id, uploader_id)
  WHERE status IN ('pending', 'processing');

-- Gallery query: entity_id + asset_type + status = 'ready' is the hot path
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_media_assets_gallery
  ON media_assets (entity_id, asset_type, created_at DESC)
  WHERE status = 'ready';

-- Orphan cleanup worker: finds old pending assets
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_media_assets_orphan_cleanup
  ON media_assets (status, created_at)
  WHERE status IN ('pending', 'processing');

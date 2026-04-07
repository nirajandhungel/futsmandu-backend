-- packages/database/prisma/migrations/005_media_assets.sql
-- Adds the MediaAssets table — the single source of truth for all uploaded files.
-- Replaces storing raw CDN URLs directly on users/owners/venues tables.
--
-- We keep profile_image_url / cover_image_url on their parent tables as DERIVED fields
-- (populated on confirm-upload via prisma update) for backward compatibility.
-- Do NOT read CDN URLs from mediaAssets directly — derive them at runtime:
--   cdnUrl = R2_CDN_BASE_URL + '/' + key
--
-- Migration is additive — no existing columns dropped in this step.

CREATE TABLE IF NOT EXISTS "media_assets" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "key"         TEXT NOT NULL,
  "asset_type"  TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | ready | failed
  "uploader_id" UUID NOT NULL,                    -- authenticated user/owner who requested the URL
  "entity_id"   TEXT NOT NULL,                    -- playerId, ownerId, or venueId
  "webp_key"    TEXT,                             -- set by processor after WebP conversion
  "metadata"    JSONB,                            -- optional: fileSize, mimeType, etc.
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for looking up assets by entity (e.g. all venue gallery images)
CREATE INDEX IF NOT EXISTS "media_assets_entity_id_idx"
  ON "media_assets" ("entity_id", "asset_type");

-- Index for admin/ops monitoring of failed/processing jobs
CREATE INDEX IF NOT EXISTS "media_assets_status_idx"
  ON "media_assets" ("status")
  WHERE "status" IN ('processing', 'failed');

-- Unique key constraint — prevents duplicate asset records for the same R2 key
CREATE UNIQUE INDEX IF NOT EXISTS "media_assets_key_unique"
  ON "media_assets" ("key");
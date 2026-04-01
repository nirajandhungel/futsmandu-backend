-- packages/database/prisma/migrations/004_owner_fcm_token.sql
-- Adds fcm_token column to owners table for Flutter push notifications.
-- Owner FCM tokens are separate from player FCm tokens (owners use Flutter, players use React Native/web).
-- Also adds refresh_token_version for owner token rotation (mirrors users table C-2 fix).
-- Run: psql $DIRECT_DATABASE_URL -f 004_owner_fcm_token.sql

-- Add FCM token for owner Flutter device push notifications
ALTER TABLE owners
  ADD COLUMN IF NOT EXISTS fcm_token TEXT;

-- Add refresh token version counter (token rotation security — mirrors users table)
ALTER TABLE owners
  ADD COLUMN IF NOT EXISTS refresh_token_version INTEGER NOT NULL DEFAULT 0;

-- Index for FCM token lookups (notification processor fetches owner by id, not by token)
-- Not indexed — we always look up by owner_id, not by fcm_token
-- But add partial index for owners with active FCM tokens (useful for bulk notification queries)
CREATE INDEX IF NOT EXISTS idx_owners_fcm_token
  ON owners(fcm_token)
  WHERE fcm_token IS NOT NULL;

-- Update Prisma schema comment placeholder
-- Remember to add to schema.prisma:
--   fcm_token             String?
--   refresh_token_version Int     @default(0)

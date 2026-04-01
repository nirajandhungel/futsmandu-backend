-- packages/database/prisma/migrations/002_refresh_token_version.sql
-- C-2: Refresh token replay attack prevention.
-- Adds refresh_token_version to users. Incremented on every token rotation.
-- JWT payload embeds version; server rejects tokens with stale version.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS refresh_token_version INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN users.refresh_token_version IS
  'Monotonic counter. Incremented on every refresh rotation. '
  'Old refresh tokens become invalid immediately after rotation.';

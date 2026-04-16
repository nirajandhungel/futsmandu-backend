-- packages/database/prisma/migrations/009_perf_optimizations.sql
-- Performance migration: composite OTP indexes + resend rate-limit index
-- Run with: psql $DIRECT_DATABASE_URL -f packages/database/prisma/migrations/009_perf_optimizations.sql
-- Or via script: pnpm --filter @futsmandu/database db:migrate
--
-- Indexes use CONCURRENTLY so they build without locking the table.
-- CONCURRENTLY cannot run inside a transaction block — run psql directly.

-- ═══════════════════════════════════════════════════════════════════════════
-- OTP ACTIVE-LOOKUP INDEXES
-- Covers: WHERE player_id = ? AND verified_at IS NULL AND expires_at > now()
-- Previous 2-column (player_id, verified_at) indexes required a re-scan of
-- every row per user to filter expires_at — this 3-column index avoids that.
-- ═══════════════════════════════════════════════════════════════════════════

-- Drop old 2-column indexes (they are superseded by the 3-column ones below)
DROP INDEX CONCURRENTLY IF EXISTS email_verification_otps_player_id_verified_at_idx;
DROP INDEX CONCURRENTLY IF EXISTS email_verification_otps_owner_id_verified_at_idx;
DROP INDEX CONCURRENTLY IF EXISTS email_verification_otps_admin_id_verified_at_idx;

-- Partial index for PLAYER active OTPs (verified_at IS NULL filters most rows)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_otp_player_active
  ON email_verification_otps(player_id, expires_at DESC)
  WHERE verified_at IS NULL;

-- Partial index for OWNER active OTPs
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_otp_owner_active
  ON email_verification_otps(owner_id, expires_at DESC)
  WHERE verified_at IS NULL;

-- Partial index for ADMIN active OTPs
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_otp_admin_active
  ON email_verification_otps(admin_id, expires_at DESC)
  WHERE verified_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- OTP RATE-LIMIT INDEX
-- Covers: resendOtp COUNT WHERE player_id = ? AND created_at > (now - 1h)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_otp_player_ratelimit
  ON email_verification_otps(player_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_otp_owner_ratelimit
  ON email_verification_otps(owner_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_otp_admin_ratelimit
  ON email_verification_otps(admin_id, created_at DESC);

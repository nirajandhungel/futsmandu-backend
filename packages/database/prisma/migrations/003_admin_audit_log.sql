-- packages/database/prisma/migrations/003_admin_audit_log.sql
-- SEC-3: Immutable audit trail for all sensitive admin operations.
-- Rows are never updated or deleted — append-only by design.

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID        NOT NULL,
  action      TEXT        NOT NULL,
  target_id   UUID,
  target_type TEXT,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE admin_audit_log IS
  'Immutable log of admin mutations. Never DELETE or UPDATE rows.';

COMMENT ON COLUMN admin_audit_log.action IS
  'SUSPEND_USER | REINSTATE_USER | OVERRIDE_PENALTY | MANUAL_REFUND | '
  'VERIFY_OWNER | REJECT_OWNER | APPROVE_REVIEW | DELETE_REVIEW | RESOLVE_DISPUTE';

CREATE INDEX IF NOT EXISTS idx_audit_admin
  ON admin_audit_log(admin_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_target
  ON admin_audit_log(target_id, target_type)
  WHERE target_id IS NOT NULL;

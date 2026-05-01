-- Security incident stream (separate from audit/activity logs).
-- Used for abuse detection events, escalation, and SOC/manual review queues.

CREATE TABLE IF NOT EXISTS security_incidents (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type     actor_type   NOT NULL,
  actor_id       UUID         NOT NULL,
  actor_role     TEXT         NOT NULL,
  incident_type  TEXT         NOT NULL,
  severity       TEXT         NOT NULL,
  level          SMALLINT     NOT NULL,
  risk_score     INT          NOT NULL,
  request_count  INT,
  ip_address     TEXT,
  user_agent     TEXT,
  endpoint       TEXT,
  method         TEXT,
  scope_key      TEXT         NOT NULL,
  cooldown_until TIMESTAMPTZ,
  metadata       JSONB,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_incidents_actor
  ON security_incidents(actor_type, actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_security_incidents_type
  ON security_incidents(incident_type, severity, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_security_incidents_scope
  ON security_incidents(scope_key, created_at DESC);

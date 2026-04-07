-- Flexible bookings + open match join flow

DO $$
BEGIN
  CREATE TYPE join_mode AS ENUM ('INVITE_ONLY', 'OPEN', 'FRIENDS_ONLY');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE cost_split_mode AS ENUM ('ADMIN_PAYS_ALL', 'SPLIT_EQUAL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE match_join_request_status AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'MATCH_JOIN_REQUEST';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'MATCH_JOIN_ACCEPTED';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'MATCH_JOIN_REJECTED';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'FRIEND_ADDED_TO_MATCH';

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS booking_meta jsonb;

ALTER TABLE match_groups
  ADD COLUMN IF NOT EXISTS join_mode join_mode NOT NULL DEFAULT 'INVITE_ONLY',
  ADD COLUMN IF NOT EXISTS cost_split_mode cost_split_mode NOT NULL DEFAULT 'ADMIN_PAYS_ALL',
  ADD COLUMN IF NOT EXISTS slots_available integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS description text;

UPDATE match_groups mg
SET slots_available = GREATEST(
  mg.max_players - (
    SELECT COUNT(*)::int
    FROM match_group_members mgm
    WHERE mgm.match_group_id = mg.id
      AND mgm.status = 'confirmed'
  ),
  0
)
WHERE mg.slots_available = 0;

ALTER TABLE match_group_members
  ADD COLUMN IF NOT EXISTS paid_amount integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_id uuid,
  ADD COLUMN IF NOT EXISTS invited_by uuid;

DO $$
BEGIN
  ALTER TABLE match_group_members
  ADD CONSTRAINT match_group_members_payment_id_fkey
  FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE match_group_members
  ADD CONSTRAINT match_group_members_invited_by_fkey
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS match_join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  message text,
  status match_join_request_status NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  responded_by uuid,
  CONSTRAINT match_join_requests_group_user_unique UNIQUE (match_group_id, user_id),
  CONSTRAINT match_join_requests_match_group_id_fkey FOREIGN KEY (match_group_id) REFERENCES match_groups(id) ON DELETE CASCADE,
  CONSTRAINT match_join_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT match_join_requests_responded_by_fkey FOREIGN KEY (responded_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_match_join_requests_group_status
  ON match_join_requests (match_group_id, status);
CREATE INDEX IF NOT EXISTS idx_match_join_requests_user_status
  ON match_join_requests (user_id, status);

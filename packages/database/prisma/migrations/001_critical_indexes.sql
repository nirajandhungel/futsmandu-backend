-- packages/database/prisma/migrations/001_critical_indexes.sql
-- Run AFTER: prisma migrate deploy (uses DIRECT_DATABASE_URL)
-- Command: psql $DIRECT_DATABASE_URL -f packages/database/prisma/migrations/001_critical_indexes.sql

-- ═══════════════════════════════════════════════════════════════════════════
-- THE MOST IMPORTANT INDEX IN THE SYSTEM
-- Prevents double-booking at the database level.
-- Exactly ONE active booking per court+date+startTime at any moment.
-- EXPIRED and CANCELLED bookings are excluded — slot becomes free again.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_slot_lock
  ON bookings(court_id, booking_date, start_time)
  WHERE status IN ('HELD', 'PENDING_PAYMENT', 'CONFIRMED');

-- Fast expiry scan (slot-expiry worker)
CREATE INDEX IF NOT EXISTS idx_bookings_expiry_active
  ON bookings(hold_expires_at)
  WHERE status IN ('HELD', 'PENDING_PAYMENT');

-- Fast payment recon scan
CREATE INDEX IF NOT EXISTS idx_payments_initiated
  ON payments(status)
  WHERE status = 'INITIATED';

-- Fast ban check (auth middleware)
CREATE INDEX IF NOT EXISTS idx_users_banned
  ON users(ban_until)
  WHERE ban_until IS NOT NULL;

-- Open match feed (discovery service)
CREATE INDEX IF NOT EXISTS idx_mg_open_matches
  ON match_groups(is_open, match_date, start_time)
  WHERE is_open = TRUE;

-- Active pricing rules (pricing engine)
CREATE INDEX IF NOT EXISTS idx_pricing_active
  ON pricing_rules(court_id, priority DESC)
  WHERE is_active = TRUE;

-- Full-text venue search
CREATE INDEX IF NOT EXISTS idx_venues_fts
  ON venues USING gin(to_tsvector('english', name || ' ' || COALESCE(description, '')));

-- ═══════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- Database-level enforcement — guards even if application logic has a bug.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE bookings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE venues        ENABLE ROW LEVEL SECURITY;

-- Players see only their own bookings
CREATE POLICY "player_own_bookings" ON bookings
  FOR SELECT USING (player_id = auth.uid());

-- Owners see bookings at their venues
CREATE POLICY "owner_venue_bookings" ON bookings
  FOR SELECT USING (
    venue_id IN (
      SELECT v.id FROM venues v
      JOIN owners o ON o.id = v.owner_id
      WHERE o.id = auth.uid()
    )
  );

-- Players see only their own payments
CREATE POLICY "player_own_payments" ON payments
  FOR SELECT USING (player_id = auth.uid());

-- Players update only their own profile
CREATE POLICY "player_own_profile" ON users
  FOR UPDATE USING (id = auth.uid());

-- Notifications: users see only their own
CREATE POLICY "own_notifications" ON notifications
  FOR ALL USING (user_id = auth.uid());

-- Anyone can read active, verified venues
CREATE POLICY "public_venues" ON venues
  FOR SELECT USING (is_active = TRUE AND is_verified = TRUE);

-- Owners can manage their own venues
CREATE POLICY "owner_own_venues" ON venues
  FOR ALL USING (
    owner_id IN (SELECT id FROM owners WHERE id = auth.uid())
  );

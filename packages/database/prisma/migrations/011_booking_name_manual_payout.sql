-- packages/database/prisma/migrations/011_booking_name_manual_payout.sql
-- Adds booking_name to bookings and enables admin-manual payout trigger.
--
-- Run with:
--   psql $DIRECT_DATABASE_URL -f packages/database/prisma/migrations/011_booking_name_manual_payout.sql

-- 1) booking_name (player-defined) shown to venue owners for on-ground verification
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS booking_name VARCHAR(80);

-- Helpful index for owner dashboards (today's bookings per venue)
CREATE INDEX IF NOT EXISTS idx_bookings_venue_date_start
  ON bookings (venue_id, booking_date, start_time);

-- 2) Payout trigger remains unchanged (manual admin payouts reuse existing trigger value).


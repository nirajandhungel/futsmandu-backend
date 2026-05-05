-- Adds deposit/remaining/pay_status to bookings.
-- Player pays deposit online; venue owner collects remaining offline.
--
-- Run with:
--   psql $DIRECT_DATABASE_URL -f packages/database/prisma/migrations/012_booking_deposit_amount.sql

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS deposit_amount integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS remaining_amount integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pay_status varchar(32) NOT NULL DEFAULT 'PENDING';

-- Backfill legacy rows:
-- before deposit feature, payments were for full total_amount.
UPDATE bookings
SET
  deposit_amount   = total_amount,
  remaining_amount = 0,
  pay_status       = CASE
    WHEN status IN ('CONFIRMED', 'COMPLETED') THEN 'PAID_FULL'
    ELSE 'PENDING'
  END
WHERE deposit_amount = 0 AND remaining_amount = 0;

CREATE INDEX IF NOT EXISTS idx_bookings_pay_status
  ON bookings (pay_status);


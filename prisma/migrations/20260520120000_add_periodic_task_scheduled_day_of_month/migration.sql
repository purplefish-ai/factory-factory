-- AlterTable
ALTER TABLE "PeriodicTask" ADD COLUMN "scheduledDayOfMonth" INTEGER;

-- Backfill existing monthly tasks without timezone from their creation date,
-- which is the only persisted signal of the originally intended monthly day.
-- SQLite cannot convert IANA timezone names, so timezone-backed rows are
-- backfilled lazily in application code using Intl before their next dispatch.
UPDATE "PeriodicTask"
SET "scheduledDayOfMonth" = CAST(strftime('%d', "createdAt") AS INTEGER)
WHERE "cadence" = 'MONTHLY' AND ("timezone" IS NULL OR "timezone" = '');

-- AlterTable
ALTER TABLE "PeriodicTask" ADD COLUMN "scheduledDayOfMonth" INTEGER;

-- Backfill existing monthly tasks from their creation date, which is the only
-- persisted signal of the originally intended monthly day.
UPDATE "PeriodicTask"
SET "scheduledDayOfMonth" = CAST(strftime('%d', "createdAt") AS INTEGER)
WHERE "cadence" = 'MONTHLY';

-- Existing runs cannot truthfully reconstruct historical launch instructions.
-- Keep their snapshot null; every new reservation writes its canonical snapshot.
ALTER TABLE "PeriodicTaskExecution" ADD COLUMN "launchSnapshot" JSONB;

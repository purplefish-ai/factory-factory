-- Existing delivery ledgers keep their behavior. Only logical import opts into a hold.
ALTER TABLE "workspace_notifications" ADD COLUMN "recovery_held" BOOLEAN NOT NULL DEFAULT false;

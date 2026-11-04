ALTER TABLE "WorkspacePR" ADD COLUMN "completionDismissed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WorkspacePR" ADD COLUMN "terminalObservedAt" DATETIME;
UPDATE "WorkspacePR" SET "terminalObservedAt" = "syncedAt" WHERE "state" IN ('MERGED', 'CLOSED');

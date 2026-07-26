-- `RatchetState` stops being stored and becomes a projection of the PR
-- observation (see `deriveRatchetState`): `WorkspaceRatchet.state` is dropped and
-- `WorkspacePR.hasMergeConflict` takes its place as the one observed fact the
-- state needed that was not already cached.
--
-- Conflicts were never persisted as a fact -- the ratchet folded them straight
-- into `state = 'MERGE_CONFLICT'` -- so that value is the only thing to backfill
-- from, and it has to be read before the column goes.


-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WorkspacePR" (
    "workspaceId" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT,
    "number" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'NONE',
    "reviewState" TEXT,
    "ciStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "hasMergeConflict" BOOLEAN NOT NULL DEFAULT false,
    "syncedAt" DATETIME,
    "discoveryLastCheckedAt" DATETIME,
    "discoveryRetryCount" INTEGER NOT NULL DEFAULT 0,
    "discoveryNextCheckAt" DATETIME,
    "ciFailedAt" DATETIME,
    "ciLastNotifiedAt" DATETIME,
    "reviewLastCheckedAt" DATETIME,
    "reviewLastCommentId" TEXT,
    CONSTRAINT "WorkspacePR_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WorkspacePR" ("ciFailedAt", "ciLastNotifiedAt", "ciStatus", "discoveryLastCheckedAt", "discoveryNextCheckAt", "discoveryRetryCount", "number", "reviewLastCheckedAt", "reviewLastCommentId", "reviewState", "state", "syncedAt", "url", "workspaceId") SELECT "ciFailedAt", "ciLastNotifiedAt", "ciStatus", "discoveryLastCheckedAt", "discoveryNextCheckAt", "discoveryRetryCount", "number", "reviewLastCheckedAt", "reviewLastCommentId", "reviewState", "state", "syncedAt", "url", "workspaceId" FROM "WorkspacePR";
DROP TABLE "WorkspacePR";
ALTER TABLE "new_WorkspacePR" RENAME TO "WorkspacePR";
CREATE INDEX "WorkspacePR_url_discoveryNextCheckAt_idx" ON "WorkspacePR"("url", "discoveryNextCheckAt");
CREATE INDEX "WorkspacePR_syncedAt_idx" ON "WorkspacePR"("syncedAt");
-- Backfill: recover the conflict flag from the state that encoded it. Runs after
-- WorkspacePR has been rebuilt with the new column and before WorkspaceRatchet
-- loses `state`.
--
-- `state` is the only contemporaneous record of a conflict, and it under-reports:
-- a failing build outranked a conflict in the derivation, so a PR with both was
-- stored as CI_FAILED and migrates as clean.
--
-- That is accepted rather than patched. The dispatch snapshot key also carries a
-- conflict (`|merge:conflict`), but it records whenever the last fixer was
-- dispatched, not the last observation -- a conflict resolved after its dispatch
-- leaves the suffix behind, and a later CI failure puts the row back in CI_FAILED,
-- so even restricting the recovery to that state cannot tell a live conflict from
-- a stale one.
--
-- Under-reporting costs nothing observable: while CI is failing the derivation
-- returns CI_FAILED and never consults the flag, and the first ratchet check after
-- CI turns green writes the true flag in the same statement that turns it green
-- (`recordPrObservation` writes all four projection inputs together). Over-
-- reporting would be visible -- a spurious conflict badge, and a conflict fixer
-- dispatched against a clean PR -- so the ambiguous source is left out.
UPDATE "WorkspacePR"
SET "hasMergeConflict" = true
WHERE "workspaceId" IN (
    SELECT "workspaceId" FROM "WorkspaceRatchet" WHERE "state" = 'MERGE_CONFLICT'
);

CREATE TABLE "new_WorkspaceRatchet" (
    "workspaceId" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedAt" DATETIME,
    "activeSessionId" TEXT,
    "dispatchSnapshotKey" TEXT,
    "dispatchOutcome" TEXT,
    "dispatchRetryCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "WorkspaceRatchet_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WorkspaceRatchet" ("activeSessionId", "dispatchOutcome", "dispatchRetryCount", "dispatchSnapshotKey", "enabled", "lastCheckedAt", "workspaceId") SELECT "activeSessionId", "dispatchOutcome", "dispatchRetryCount", "dispatchSnapshotKey", "enabled", "lastCheckedAt", "workspaceId" FROM "WorkspaceRatchet";
DROP TABLE "WorkspaceRatchet";
ALTER TABLE "new_WorkspaceRatchet" RENAME TO "WorkspaceRatchet";
CREATE INDEX "WorkspaceRatchet_lastCheckedAt_idx" ON "WorkspaceRatchet"("lastCheckedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;


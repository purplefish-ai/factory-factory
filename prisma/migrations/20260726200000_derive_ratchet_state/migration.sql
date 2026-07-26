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
-- Backfill: recover the conflict flag from the two places that encoded it. Runs
-- after WorkspacePR has been rebuilt with the new column and before
-- WorkspaceRatchet loses `state`.
--
-- `state` alone under-reports, because a failing build outranked a conflict in
-- the derivation: a PR with both was stored as CI_FAILED. The dispatch snapshot
-- key records the conflict independently (`|merge:conflict`), so it recovers the
-- masked cases.
--
-- The key persists after its dispatch settles, so it cannot be trusted on its own
-- -- a resolved conflict leaves the suffix behind. CI_FAILED is the only state
-- where it is safe to believe, and that is exactly the masked case: any other
-- state proves there was no conflict at the last observation, because a conflict
-- would have produced MERGE_CONFLICT instead. Restricted to still-open PRs too,
-- since a closed or merged PR short-circuits before the flag is read.
UPDATE "WorkspacePR"
SET "hasMergeConflict" = true
WHERE "workspaceId" IN (
    SELECT "workspaceId" FROM "WorkspaceRatchet" WHERE "state" = 'MERGE_CONFLICT'
);

UPDATE "WorkspacePR"
SET "hasMergeConflict" = true
WHERE "state" IN ('OPEN', 'DRAFT', 'CHANGES_REQUESTED', 'APPROVED')
  AND "workspaceId" IN (
    SELECT "workspaceId" FROM "WorkspaceRatchet"
    WHERE "state" = 'CI_FAILED'
      AND "dispatchSnapshotKey" LIKE '%|merge:conflict'
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


-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WorkspaceRatchet" (
    "workspaceId" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedAt" DATETIME,
    "activeSessionId" TEXT,
    "dispatchSnapshotKey" TEXT,
    "dispatchOutcome" TEXT,
    "dispatchRetryCount" INTEGER NOT NULL DEFAULT 0,
    "dispatchStalled" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "WorkspaceRatchet_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WorkspaceRatchet" ("activeSessionId", "dispatchOutcome", "dispatchRetryCount", "dispatchSnapshotKey", "enabled", "lastCheckedAt", "workspaceId") SELECT "activeSessionId", "dispatchOutcome", "dispatchRetryCount", "dispatchSnapshotKey", "enabled", "lastCheckedAt", "workspaceId" FROM "WorkspaceRatchet";
DROP TABLE "WorkspaceRatchet";
ALTER TABLE "new_WorkspaceRatchet" RENAME TO "WorkspaceRatchet";
CREATE INDEX "WorkspaceRatchet_lastCheckedAt_idx" ON "WorkspaceRatchet"("lastCheckedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

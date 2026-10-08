PRAGMA foreign_keys=OFF;
CREATE TABLE "WorkspacePRDiscovery" (
 "workspaceId" TEXT NOT NULL PRIMARY KEY,
 "lastCheckedAt" DATETIME, "retryCount" INTEGER NOT NULL DEFAULT 0, "nextCheckAt" DATETIME,
 CONSTRAINT "WorkspacePRDiscovery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "WorkspacePRDiscovery" ("workspaceId", "lastCheckedAt", "retryCount", "nextCheckAt")
 SELECT w."id", p."discoveryLastCheckedAt", COALESCE(p."discoveryRetryCount",0), p."discoveryNextCheckAt" FROM "Workspace" w LEFT JOIN "WorkspacePR" p ON p."workspaceId"=w."id";
CREATE TABLE "new_WorkspacePR" (
 "id" TEXT NOT NULL PRIMARY KEY, "workspaceId" TEXT NOT NULL, "url" TEXT NOT NULL, "number" INTEGER,
 "title" TEXT, "headRefName" TEXT, "baseRefName" TEXT,
 "state" TEXT NOT NULL DEFAULT 'NONE', "reviewState" TEXT,
 "ciStatus" TEXT NOT NULL DEFAULT 'UNKNOWN', "hasMergeConflict" BOOLEAN NOT NULL DEFAULT false,
 "syncedAt" DATETIME, "detachedAt" DATETIME, "revision" INTEGER NOT NULL DEFAULT 0,
 "ciFailedAt" DATETIME, "ciLastNotifiedAt" DATETIME, "reviewLastCheckedAt" DATETIME, "reviewLastCommentId" TEXT,
 CONSTRAINT "WorkspacePR_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WorkspacePR" ("id","workspaceId","url","number","state","reviewState","ciStatus","hasMergeConflict","syncedAt","ciFailedAt","ciLastNotifiedAt","reviewLastCheckedAt","reviewLastCommentId")
 SELECT 'legacy-pr-'||"workspaceId","workspaceId","url","number","state","reviewState","ciStatus","hasMergeConflict","syncedAt","ciFailedAt","ciLastNotifiedAt","reviewLastCheckedAt","reviewLastCommentId" FROM "WorkspacePR" WHERE "url" IS NOT NULL;
CREATE TABLE "WorkspacePRRatchet" (
 "prId" TEXT NOT NULL PRIMARY KEY, "lastCheckedAt" DATETIME, "activeSessionId" TEXT,
 "dispatchSnapshotKey" TEXT, "dispatchOutcome" TEXT, "dispatchRetryCount" INTEGER NOT NULL DEFAULT 0, "dispatchStalled" BOOLEAN NOT NULL DEFAULT false,
 CONSTRAINT "WorkspacePRRatchet_prId_fkey" FOREIGN KEY ("prId") REFERENCES "WorkspacePR" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "WorkspacePRRatchet" ("prId","lastCheckedAt","activeSessionId","dispatchSnapshotKey","dispatchOutcome","dispatchRetryCount","dispatchStalled")
 SELECT p."id",r."lastCheckedAt",r."activeSessionId",r."dispatchSnapshotKey",r."dispatchOutcome",COALESCE(r."dispatchRetryCount",0),COALESCE(r."dispatchStalled",false) FROM "new_WorkspacePR" p LEFT JOIN "WorkspaceRatchet" r ON r."workspaceId"=p."workspaceId";
CREATE TABLE "new_WorkspaceRatchet" (
 "workspaceId" TEXT NOT NULL PRIMARY KEY, "enabled" BOOLEAN NOT NULL DEFAULT true, "lastCheckedAt" DATETIME,
 "activeSessionId" TEXT, "activePrId" TEXT,
 CONSTRAINT "WorkspaceRatchet_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "WorkspaceRatchet_activePrId_fkey" FOREIGN KEY ("activePrId") REFERENCES "WorkspacePR" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_WorkspaceRatchet" ("workspaceId","enabled","lastCheckedAt","activeSessionId","activePrId")
 SELECT r."workspaceId",r."enabled",r."lastCheckedAt",CASE WHEN p."id" IS NOT NULL THEN r."activeSessionId" END,CASE WHEN r."activeSessionId" IS NOT NULL THEN p."id" END FROM "WorkspaceRatchet" r LEFT JOIN "new_WorkspacePR" p ON p."workspaceId"=r."workspaceId";
DROP TABLE "WorkspaceRatchet";
DROP TABLE "WorkspacePR";
ALTER TABLE "new_WorkspacePR" RENAME TO "WorkspacePR";
ALTER TABLE "new_WorkspaceRatchet" RENAME TO "WorkspaceRatchet";
CREATE UNIQUE INDEX "WorkspacePR_workspaceId_url_key" ON "WorkspacePR"("workspaceId","url");
CREATE INDEX "WorkspacePR_workspaceId_detachedAt_idx" ON "WorkspacePR"("workspaceId","detachedAt");
CREATE INDEX "WorkspacePR_syncedAt_idx" ON "WorkspacePR"("syncedAt");
CREATE INDEX "WorkspacePRDiscovery_nextCheckAt_idx" ON "WorkspacePRDiscovery"("nextCheckAt");
CREATE INDEX "WorkspacePRRatchet_lastCheckedAt_idx" ON "WorkspacePRRatchet"("lastCheckedAt");
CREATE INDEX "WorkspaceRatchet_lastCheckedAt_idx" ON "WorkspaceRatchet"("lastCheckedAt");
CREATE INDEX "WorkspaceRatchet_activePrId_idx" ON "WorkspaceRatchet"("activePrId");
PRAGMA foreign_keys=ON;

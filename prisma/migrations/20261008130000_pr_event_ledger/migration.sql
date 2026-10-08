ALTER TABLE "WorkspacePR" ADD COLUMN "observation" JSONB;
ALTER TABLE "WorkspacePR" ADD COLUMN "transitionSequence" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WorkspacePR" ADD COLUMN "observationEpoch" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "WorkspacePRMonitoring" (
 "workspaceId" TEXT NOT NULL PRIMARY KEY,
 "enabled" BOOLEAN NOT NULL DEFAULT false,
 "recipientSessionId" TEXT,
 "bindingRevision" INTEGER NOT NULL DEFAULT 0,
 "eventEpoch" INTEGER NOT NULL DEFAULT 0,
 "deliveryPauseReason" TEXT,
 "lastCheckedAt" DATETIME,
 CONSTRAINT "WorkspacePRMonitoring_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "WorkspacePRMonitoring_recipientSessionId_fkey" FOREIGN KEY ("recipientSessionId") REFERENCES "AgentSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "WorkspacePRMonitoring" ("workspaceId", "enabled", "eventEpoch", "lastCheckedAt", "deliveryPauseReason")
 SELECT "workspaceId", "enabled", CASE WHEN "enabled" THEN 1 ELSE 0 END, "lastCheckedAt", CASE WHEN "activeSessionId" IS NOT NULL THEN 'LEGACY_FIXER' ELSE NULL END FROM "WorkspaceRatchet";
CREATE INDEX "WorkspacePRMonitoring_recipientSessionId_idx" ON "WorkspacePRMonitoring"("recipientSessionId");
CREATE TABLE "WorkspacePREvent" (
 "id" TEXT NOT NULL PRIMARY KEY, "workspaceId" TEXT NOT NULL, "prId" TEXT,
 "kind" TEXT NOT NULL, "deduplicationKey" TEXT NOT NULL, "payload" JSONB NOT NULL,
 "state" TEXT NOT NULL DEFAULT 'PENDING' CHECK("state" IN ('PENDING','DISPATCHING','DELIVERED','SUPERSEDED','CANCELLED')),
 "attempts" INTEGER NOT NULL DEFAULT 0, "deliveryId" TEXT, "deliverySessionId" TEXT,
 "deliveryBindingRevision" INTEGER, "deliveryText" TEXT, "claimedAt" DATETIME,
 "deliveredAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "WorkspacePREvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "WorkspacePREvent_prId_fkey" FOREIGN KEY ("prId") REFERENCES "WorkspacePR" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WorkspacePREvent_prId_deduplicationKey_key" ON "WorkspacePREvent"("prId", "deduplicationKey");
CREATE UNIQUE INDEX "WorkspacePREvent_workspaceId_deduplicationKey_key" ON "WorkspacePREvent"("workspaceId", "deduplicationKey");
CREATE INDEX "WorkspacePREvent_workspaceId_state_createdAt_idx" ON "WorkspacePREvent"("workspaceId", "state", "createdAt");
CREATE INDEX "WorkspacePREvent_deliveryId_idx" ON "WorkspacePREvent"("deliveryId");

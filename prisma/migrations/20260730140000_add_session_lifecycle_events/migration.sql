CREATE TABLE "SessionLifecycleEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionLifecycleEvent_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SessionLifecycleEvent_sessionId_dedupeKey_key"
  ON "SessionLifecycleEvent"("sessionId", "dedupeKey");
CREATE INDEX "SessionLifecycleEvent_sessionId_createdAt_idx"
  ON "SessionLifecycleEvent"("sessionId", "createdAt");
CREATE INDEX "SessionLifecycleEvent_workspaceId_idx"
  ON "SessionLifecycleEvent"("workspaceId");

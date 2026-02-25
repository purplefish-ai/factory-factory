-- CreateTable
CREATE TABLE "ClosedSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "name" TEXT,
    "workflow" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "transcriptPath" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "completedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClosedSession_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ClosedSession_workspaceId_idx" ON "ClosedSession"("workspaceId");

-- CreateIndex
CREATE INDEX "ClosedSession_completedAt_idx" ON "ClosedSession"("completedAt");

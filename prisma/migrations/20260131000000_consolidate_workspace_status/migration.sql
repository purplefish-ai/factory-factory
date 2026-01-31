-- Consolidate WorkspaceStatus and WorkspaceInitStatus into single enum
-- Migration mapping:
--   (ACTIVE, PENDING) → NEW
--   (ACTIVE, INITIALIZING) → PROVISIONING
--   (ACTIVE, READY) → READY
--   (ACTIVE, FAILED) → FAILED
--   (COMPLETED, *) → READY
--   (ARCHIVED, *) → ARCHIVED

-- SQLite requires table recreation to remove columns and change defaults

PRAGMA foreign_keys=OFF;

-- Create new table with consolidated status
CREATE TABLE "new_Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "worktreePath" TEXT,
    "branchName" TEXT,
    "initErrorMessage" TEXT,
    "initStartedAt" DATETIME,
    "initCompletedAt" DATETIME,
    "initRetryCount" INTEGER NOT NULL DEFAULT 0,
    "runScriptCommand" TEXT,
    "runScriptCleanupCommand" TEXT,
    "runScriptPid" INTEGER,
    "runScriptPort" INTEGER,
    "runScriptStartedAt" DATETIME,
    "runScriptStatus" TEXT NOT NULL DEFAULT 'IDLE',
    "prUrl" TEXT,
    "githubIssueNumber" INTEGER,
    "githubIssueUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "prNumber" INTEGER,
    "prState" TEXT NOT NULL DEFAULT 'NONE',
    "prReviewState" TEXT,
    "prCiStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "prUpdatedAt" DATETIME,
    "hasHadSessions" BOOLEAN NOT NULL DEFAULT false,
    "cachedKanbanColumn" TEXT NOT NULL DEFAULT 'BACKLOG',
    "stateComputedAt" DATETIME,
    CONSTRAINT "Workspace_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Migrate data with status mapping
INSERT INTO "new_Workspace" (
    "id", "projectId", "name", "description", "status", "worktreePath", "branchName",
    "initErrorMessage", "initStartedAt", "initCompletedAt", "initRetryCount",
    "runScriptCommand", "runScriptCleanupCommand", "runScriptPid", "runScriptPort",
    "runScriptStartedAt", "runScriptStatus", "prUrl", "githubIssueNumber", "githubIssueUrl",
    "createdAt", "updatedAt", "prNumber", "prState", "prReviewState", "prCiStatus",
    "prUpdatedAt", "hasHadSessions", "cachedKanbanColumn", "stateComputedAt"
)
SELECT
    "id", "projectId", "name", "description",
    CASE
        WHEN "status" = 'ARCHIVED' THEN 'ARCHIVED'
        WHEN "status" = 'COMPLETED' THEN 'READY'
        WHEN "status" = 'ACTIVE' AND "initStatus" = 'PENDING' THEN 'NEW'
        WHEN "status" = 'ACTIVE' AND "initStatus" = 'INITIALIZING' THEN 'PROVISIONING'
        WHEN "status" = 'ACTIVE' AND "initStatus" = 'READY' THEN 'READY'
        WHEN "status" = 'ACTIVE' AND "initStatus" = 'FAILED' THEN 'FAILED'
        ELSE 'NEW'  -- Default fallback
    END as "status",
    "worktreePath", "branchName", "initErrorMessage", "initStartedAt", "initCompletedAt",
    "initRetryCount", "runScriptCommand", "runScriptCleanupCommand", "runScriptPid",
    "runScriptPort", "runScriptStartedAt", "runScriptStatus", "prUrl", "githubIssueNumber",
    "githubIssueUrl", "createdAt", "updatedAt", "prNumber", "prState", "prReviewState",
    "prCiStatus", "prUpdatedAt", "hasHadSessions", "cachedKanbanColumn", "stateComputedAt"
FROM "Workspace";

-- Drop old table
DROP TABLE "Workspace";

-- Rename new table
ALTER TABLE "new_Workspace" RENAME TO "Workspace";

-- Recreate indexes
CREATE INDEX "Workspace_projectId_idx" ON "Workspace"("projectId");
CREATE INDEX "Workspace_status_idx" ON "Workspace"("status");
CREATE INDEX "Workspace_cachedKanbanColumn_idx" ON "Workspace"("cachedKanbanColumn");
CREATE INDEX "Workspace_projectId_status_idx" ON "Workspace"("projectId", "status");
CREATE INDEX "Workspace_projectId_cachedKanbanColumn_idx" ON "Workspace"("projectId", "cachedKanbanColumn");

PRAGMA foreign_keys=ON;

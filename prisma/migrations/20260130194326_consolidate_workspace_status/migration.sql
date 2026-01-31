-- ConsolidateWorkspaceStatus
-- Merges WorkspaceStatus and WorkspaceInitStatus into a single WorkspaceStatus enum
-- Migration logic:
--   ACTIVE + READY -> READY
--   ACTIVE + PENDING -> NEW
--   ACTIVE + INITIALIZING -> PROVISIONING
--   ACTIVE + FAILED -> FAILED
--   COMPLETED or ARCHIVED -> ARCHIVED

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- Create new Workspace table with consolidated status and renamed fields
CREATE TABLE "new_Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "worktreePath" TEXT,
    "branchName" TEXT,
    "errorMessage" TEXT,
    "provisioningStartedAt" DATETIME,
    "provisioningCompletedAt" DATETIME,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
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

-- Migrate data with status consolidation logic
INSERT INTO "new_Workspace" (
    "id",
    "projectId",
    "name",
    "description",
    "status",
    "worktreePath",
    "branchName",
    "errorMessage",
    "provisioningStartedAt",
    "provisioningCompletedAt",
    "retryCount",
    "prUrl",
    "githubIssueNumber",
    "githubIssueUrl",
    "createdAt",
    "updatedAt",
    "prNumber",
    "prState",
    "prReviewState",
    "prCiStatus",
    "prUpdatedAt",
    "hasHadSessions",
    "cachedKanbanColumn",
    "stateComputedAt"
)
SELECT
    "id",
    "projectId",
    "name",
    "description",
    -- Consolidated status logic
    CASE
        WHEN "status" IN ('COMPLETED', 'ARCHIVED') THEN 'ARCHIVED'
        WHEN "status" = 'ACTIVE' AND "initStatus" = 'READY' THEN 'READY'
        WHEN "status" = 'ACTIVE' AND "initStatus" = 'PENDING' THEN 'NEW'
        WHEN "status" = 'ACTIVE' AND "initStatus" = 'INITIALIZING' THEN 'PROVISIONING'
        WHEN "status" = 'ACTIVE' AND "initStatus" = 'FAILED' THEN 'FAILED'
        ELSE 'NEW'  -- Fallback for any unexpected combinations
    END,
    "worktreePath",
    "branchName",
    "initErrorMessage",
    "initStartedAt",
    "initCompletedAt",
    "initRetryCount",
    "prUrl",
    "githubIssueNumber",
    "githubIssueUrl",
    "createdAt",
    "updatedAt",
    "prNumber",
    "prState",
    "prReviewState",
    "prCiStatus",
    "prUpdatedAt",
    "hasHadSessions",
    "cachedKanbanColumn",
    "stateComputedAt"
FROM "Workspace";

-- Drop old table and rename new one
DROP TABLE "Workspace";
ALTER TABLE "new_Workspace" RENAME TO "Workspace";

-- Recreate indexes
CREATE INDEX "Workspace_projectId_idx" ON "Workspace"("projectId");
CREATE INDEX "Workspace_status_idx" ON "Workspace"("status");
CREATE INDEX "Workspace_cachedKanbanColumn_idx" ON "Workspace"("cachedKanbanColumn");
CREATE INDEX "Workspace_projectId_status_idx" ON "Workspace"("projectId", "status");
CREATE INDEX "Workspace_projectId_cachedKanbanColumn_idx" ON "Workspace"("projectId", "cachedKanbanColumn");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

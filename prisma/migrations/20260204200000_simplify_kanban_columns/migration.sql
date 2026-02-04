-- Simplify KanbanColumn enum from 7 values to 3: WORKING, WAITING, DONE
-- Migration strategy:
-- - BACKLOG, IN_PROGRESS -> WORKING (initializing or actively working)
-- - PR_OPEN, WAITING, APPROVED -> WAITING (idle, waiting for input)
-- - MERGED, DONE -> DONE (completed)

-- Step 1: Update existing cachedKanbanColumn values to new enum values
UPDATE "Workspace"
SET "cachedKanbanColumn" = CASE
  WHEN "cachedKanbanColumn" IN ('BACKLOG', 'IN_PROGRESS') THEN 'WORKING'
  WHEN "cachedKanbanColumn" IN ('PR_OPEN', 'WAITING', 'APPROVED') THEN 'WAITING'
  WHEN "cachedKanbanColumn" IN ('MERGED', 'DONE') THEN 'DONE'
  ELSE 'WAITING'
END;

-- Step 2: Recreate table with new default value (WAITING instead of BACKLOG)
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "worktreePath" TEXT,
    "branchName" TEXT,
    "initErrorMessage" TEXT,
    "initOutput" TEXT,
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
    "prCiFailedAt" DATETIME,
    "prCiLastNotifiedAt" DATETIME,
    "prReviewLastCheckedAt" DATETIME,
    "prReviewLastCommentId" TEXT,
    "ratchetState" TEXT NOT NULL DEFAULT 'IDLE',
    "ratchetLastCheckedAt" DATETIME,
    "ratchetActiveSessionId" TEXT,
    "ratchetLastCiRunId" TEXT,
    "ratchetLastNotifiedState" TEXT,
    "hasHadSessions" BOOLEAN NOT NULL DEFAULT false,
    "cachedKanbanColumn" TEXT NOT NULL DEFAULT 'WAITING',
    "stateComputedAt" DATETIME,
    CONSTRAINT "Workspace_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Workspace" ("branchName", "cachedKanbanColumn", "createdAt", "description", "githubIssueNumber", "githubIssueUrl", "hasHadSessions", "id", "initCompletedAt", "initErrorMessage", "initOutput", "initRetryCount", "initStartedAt", "name", "prCiFailedAt", "prCiLastNotifiedAt", "prCiStatus", "prNumber", "prReviewLastCheckedAt", "prReviewLastCommentId", "prReviewState", "prState", "prUpdatedAt", "prUrl", "projectId", "ratchetActiveSessionId", "ratchetLastCheckedAt", "ratchetLastCiRunId", "ratchetLastNotifiedState", "ratchetState", "runScriptCleanupCommand", "runScriptCommand", "runScriptPid", "runScriptPort", "runScriptStartedAt", "runScriptStatus", "stateComputedAt", "status", "updatedAt", "worktreePath") SELECT "branchName", "cachedKanbanColumn", "createdAt", "description", "githubIssueNumber", "githubIssueUrl", "hasHadSessions", "id", "initCompletedAt", "initErrorMessage", "initOutput", "initRetryCount", "initStartedAt", "name", "prCiFailedAt", "prCiLastNotifiedAt", "prCiStatus", "prNumber", "prReviewLastCheckedAt", "prReviewLastCommentId", "prReviewState", "prState", "prUpdatedAt", "prUrl", "projectId", "ratchetActiveSessionId", "ratchetLastCheckedAt", "ratchetLastCiRunId", "ratchetLastNotifiedState", "ratchetState", "runScriptCleanupCommand", "runScriptCommand", "runScriptPid", "runScriptPort", "runScriptStartedAt", "runScriptStatus", "stateComputedAt", "status", "updatedAt", "worktreePath" FROM "Workspace";
DROP TABLE "Workspace";
ALTER TABLE "new_Workspace" RENAME TO "Workspace";
CREATE INDEX "Workspace_projectId_idx" ON "Workspace"("projectId");
CREATE INDEX "Workspace_status_idx" ON "Workspace"("status");
CREATE INDEX "Workspace_cachedKanbanColumn_idx" ON "Workspace"("cachedKanbanColumn");
CREATE INDEX "Workspace_projectId_status_idx" ON "Workspace"("projectId", "status");
CREATE INDEX "Workspace_projectId_cachedKanbanColumn_idx" ON "Workspace"("projectId", "cachedKanbanColumn");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

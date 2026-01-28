-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "worktreePath" TEXT,
    "branchName" TEXT,
    "initStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "initErrorMessage" TEXT,
    "initStartedAt" DATETIME,
    "initCompletedAt" DATETIME,
    "initRetryCount" INTEGER NOT NULL DEFAULT 0,
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
INSERT INTO "new_Workspace" ("branchName", "cachedKanbanColumn", "createdAt", "description", "githubIssueNumber", "githubIssueUrl", "hasHadSessions", "id", "initCompletedAt", "initErrorMessage", "initRetryCount", "initStartedAt", "initStatus", "name", "prNumber", "prReviewState", "prState", "prUpdatedAt", "prUrl", "projectId", "stateComputedAt", "status", "updatedAt", "worktreePath") SELECT "branchName", "cachedKanbanColumn", "createdAt", "description", "githubIssueNumber", "githubIssueUrl", "hasHadSessions", "id", "initCompletedAt", "initErrorMessage", "initRetryCount", "initStartedAt", "initStatus", "name", "prNumber", "prReviewState", "prState", "prUpdatedAt", "prUrl", "projectId", "stateComputedAt", "status", "updatedAt", "worktreePath" FROM "Workspace";
DROP TABLE "Workspace";
ALTER TABLE "new_Workspace" RENAME TO "Workspace";
CREATE INDEX "Workspace_projectId_idx" ON "Workspace"("projectId");
CREATE INDEX "Workspace_status_idx" ON "Workspace"("status");
CREATE INDEX "Workspace_cachedKanbanColumn_idx" ON "Workspace"("cachedKanbanColumn");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

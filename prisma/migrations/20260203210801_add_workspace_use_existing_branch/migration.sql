/*
  Warnings:

  - You are about to alter the column `cachedSlashCommands` on the `UserSettings` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.
  - You are about to alter the column `workspaceOrder` on the `UserSettings` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_UserSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL DEFAULT 'default',
    "preferredIde" TEXT NOT NULL DEFAULT 'cursor',
    "customIdeCommand" TEXT,
    "playSoundOnComplete" BOOLEAN NOT NULL DEFAULT true,
    "notificationSoundPath" TEXT,
    "workspaceOrder" JSONB,
    "cachedSlashCommands" JSONB,
    "autoFixCiIssues" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_UserSettings" ("cachedSlashCommands", "createdAt", "customIdeCommand", "id", "playSoundOnComplete", "preferredIde", "updatedAt", "userId", "workspaceOrder") SELECT "cachedSlashCommands", "createdAt", "customIdeCommand", "id", "playSoundOnComplete", "preferredIde", "updatedAt", "userId", "workspaceOrder" FROM "UserSettings";
DROP TABLE "UserSettings";
ALTER TABLE "new_UserSettings" RENAME TO "UserSettings";
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");
CREATE INDEX "UserSettings_userId_idx" ON "UserSettings"("userId");
CREATE TABLE "new_Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "worktreePath" TEXT,
    "branchName" TEXT,
    "useExistingBranch" BOOLEAN NOT NULL DEFAULT false,
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
    "hasHadSessions" BOOLEAN NOT NULL DEFAULT false,
    "cachedKanbanColumn" TEXT NOT NULL DEFAULT 'BACKLOG',
    "stateComputedAt" DATETIME,
    CONSTRAINT "Workspace_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Workspace" ("branchName", "cachedKanbanColumn", "createdAt", "description", "githubIssueNumber", "githubIssueUrl", "hasHadSessions", "id", "initCompletedAt", "initErrorMessage", "initOutput", "initRetryCount", "initStartedAt", "name", "prCiFailedAt", "prCiLastNotifiedAt", "prCiStatus", "prNumber", "prReviewState", "prState", "prUpdatedAt", "prUrl", "projectId", "runScriptCleanupCommand", "runScriptCommand", "runScriptPid", "runScriptPort", "runScriptStartedAt", "runScriptStatus", "stateComputedAt", "status", "updatedAt", "worktreePath") SELECT "branchName", "cachedKanbanColumn", "createdAt", "description", "githubIssueNumber", "githubIssueUrl", "hasHadSessions", "id", "initCompletedAt", "initErrorMessage", "initOutput", "initRetryCount", "initStartedAt", "name", "prCiFailedAt", "prCiLastNotifiedAt", "prCiStatus", "prNumber", "prReviewState", "prState", "prUpdatedAt", "prUrl", "projectId", "runScriptCleanupCommand", "runScriptCommand", "runScriptPid", "runScriptPort", "runScriptStartedAt", "runScriptStatus", "stateComputedAt", "status", "updatedAt", "worktreePath" FROM "Workspace";
DROP TABLE "Workspace";
ALTER TABLE "new_Workspace" RENAME TO "Workspace";
CREATE INDEX "Workspace_projectId_idx" ON "Workspace"("projectId");
CREATE INDEX "Workspace_status_idx" ON "Workspace"("status");
CREATE INDEX "Workspace_cachedKanbanColumn_idx" ON "Workspace"("cachedKanbanColumn");
CREATE INDEX "Workspace_projectId_status_idx" ON "Workspace"("projectId", "status");
CREATE INDEX "Workspace_projectId_cachedKanbanColumn_idx" ON "Workspace"("projectId", "cachedKanbanColumn");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

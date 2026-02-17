-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN "linearIssueId" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "linearIssueIdentifier" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "linearIssueUrl" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "repoPath" TEXT NOT NULL,
    "worktreeBasePath" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "githubOwner" TEXT,
    "githubRepo" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "issueProvider" TEXT NOT NULL DEFAULT 'GITHUB',
    "issueTrackerConfig" JSONB,
    "startupScriptCommand" TEXT,
    "startupScriptPath" TEXT,
    "startupScriptTimeout" INTEGER NOT NULL DEFAULT 300,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Project" ("createdAt", "defaultBranch", "githubOwner", "githubRepo", "id", "isArchived", "name", "repoPath", "slug", "startupScriptCommand", "startupScriptPath", "startupScriptTimeout", "updatedAt", "worktreeBasePath") SELECT "createdAt", "defaultBranch", "githubOwner", "githubRepo", "id", "isArchived", "name", "repoPath", "slug", "startupScriptCommand", "startupScriptPath", "startupScriptTimeout", "updatedAt", "worktreeBasePath" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");
CREATE INDEX "Project_slug_idx" ON "Project"("slug");
CREATE INDEX "Project_isArchived_idx" ON "Project"("isArchived");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

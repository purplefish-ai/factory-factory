ALTER TABLE "WorkspaceLaunchOrigin" ADD COLUMN "childHistoryVersion" INTEGER;

CREATE TABLE "WorkspaceChildOrigin" (
    "parentWorkspaceId" TEXT NOT NULL,
    "childWorkspaceId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("parentWorkspaceId", "childWorkspaceId")
);

-- Surviving children establish holds only. No historical origin gains coverage.
INSERT INTO "WorkspaceChildOrigin" ("parentWorkspaceId", "childWorkspaceId", "createdAt")
SELECT "parent_workspace_id", "id", "createdAt" FROM "Workspace"
WHERE "parent_workspace_id" IS NOT NULL;

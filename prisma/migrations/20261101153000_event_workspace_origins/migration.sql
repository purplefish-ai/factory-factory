-- CreateTable
CREATE TABLE "WorkspaceLaunchOrigin" (
    "runId" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceLaunchOrigin_workspaceId_key" ON "WorkspaceLaunchOrigin"("workspaceId");

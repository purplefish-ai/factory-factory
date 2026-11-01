-- CreateTable
CREATE TABLE "AgentSessionLaunchOrigin" (
    "runId" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "execution" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentSessionLaunchOrigin_sessionId_key" ON "AgentSessionLaunchOrigin"("sessionId");

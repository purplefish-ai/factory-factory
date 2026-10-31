CREATE TABLE "AgentProposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "specification" JSONB NOT NULL,
    "sourceNames" JSONB NOT NULL DEFAULT '{}',
    "agentDefinitionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentProposal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentProposal_agentDefinitionId_fkey" FOREIGN KEY ("agentDefinitionId") REFERENCES "AgentDefinition" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AgentProposal_agentDefinitionId_key" ON "AgentProposal"("agentDefinitionId");
CREATE INDEX "AgentProposal_workspaceId_idx" ON "AgentProposal"("workspaceId");

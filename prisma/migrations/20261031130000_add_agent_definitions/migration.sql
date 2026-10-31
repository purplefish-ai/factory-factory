-- CreateTable
CREATE TABLE "AgentDefinition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "executionConfig" JSONB NOT NULL DEFAULT '{"version":1}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentDefinition_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "credentialsEncrypted" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AgentTrigger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentDefinitionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "connectionId" TEXT,
    "description" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "filterInstructions" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentTrigger_agentDefinitionId_fkey" FOREIGN KEY ("agentDefinitionId") REFERENCES "AgentDefinition" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentTrigger_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AgentConnection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentDefinitionId" TEXT NOT NULL,
    "triggerId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "definitionSnapshot" JSONB NOT NULL,
    "triggerSnapshot" JSONB,
    "input" JSONB NOT NULL,
    "workspaceId" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "AgentRun_agentDefinitionId_fkey" FOREIGN KEY ("agentDefinitionId") REFERENCES "AgentDefinition" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentRun_triggerId_agentDefinitionId_fkey" FOREIGN KEY ("triggerId", "agentDefinitionId") REFERENCES "AgentTrigger" ("id", "agentDefinitionId") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "AgentRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AgentDefinition_projectId_isEnabled_idx" ON "AgentDefinition"("projectId", "isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "AgentConnection_provider_externalId_key" ON "AgentConnection"("provider", "externalId");

-- CreateIndex
CREATE INDEX "AgentTrigger_agentDefinitionId_isEnabled_idx" ON "AgentTrigger"("agentDefinitionId", "isEnabled");

-- CreateIndex
CREATE INDEX "AgentTrigger_connectionId_type_isEnabled_idx" ON "AgentTrigger"("connectionId", "type", "isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTrigger_id_agentDefinitionId_key" ON "AgentTrigger"("id", "agentDefinitionId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_workspaceId_key" ON "AgentRun"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentRun_agentDefinitionId_createdAt_idx" ON "AgentRun"("agentDefinitionId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_triggerId_agentDefinitionId_idx" ON "AgentRun"("triggerId", "agentDefinitionId");

-- CreateIndex
CREATE INDEX "AgentRun_status_createdAt_idx" ON "AgentRun"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_agentDefinitionId_idempotencyKey_key" ON "AgentRun"("agentDefinitionId", "idempotencyKey");

-- CreateTable
CREATE TABLE "AgentSourceState" (
    "lastSourceOrder" INTEGER NOT NULL DEFAULT 0,
    "connectionId" TEXT NOT NULL PRIMARY KEY,
    "isReady" BOOLEAN NOT NULL DEFAULT false,
    "cursor" JSONB,
    "health" JSONB,
    "lastObservedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentSourceState_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AgentConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connectionId" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "sourceOrder" INTEGER CHECK ("sourceOrder" IS NULL OR ("sourceOrder" > 0 AND "sourceOrder" <= 2147483647)),
    "payload" JSONB,
    "occurredAt" DATETIME NOT NULL,
    "observedAt" DATETIME NOT NULL,
    "payloadExpiresAt" DATETIME NOT NULL,
    "identityExpiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AgentConnection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentEvaluation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "agentDefinitionId" TEXT NOT NULL,
    "triggerId" TEXT NOT NULL,
    "definitionRevision" INTEGER NOT NULL,
    "triggerRevision" INTEGER NOT NULL,
    "activationGeneration" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "configurationSnapshot" JSONB NOT NULL,
    "classifier" JSONB,
    "runId" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentEvaluation_eventId_connectionId_fkey" FOREIGN KEY ("eventId", "connectionId") REFERENCES "AgentEvent" ("id", "connectionId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentEvaluation_agentDefinitionId_fkey" FOREIGN KEY ("agentDefinitionId") REFERENCES "AgentDefinition" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentEvaluation_triggerId_agentDefinitionId_connectionId_fkey" FOREIGN KEY ("triggerId", "agentDefinitionId", "connectionId") REFERENCES "AgentTrigger" ("id", "agentDefinitionId", "connectionId") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "AgentEvaluation_runId_agentDefinitionId_eventId_fkey" FOREIGN KEY ("runId", "agentDefinitionId", "eventId") REFERENCES "AgentRun" ("id", "agentDefinitionId", "eventId") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "AgentInitialDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptGeneration" INTEGER NOT NULL DEFAULT 1,
    "sendAttemptId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "providerTurnId" TEXT,
    "sendingAt" DATETIME,
    "acceptedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentInitialDelivery_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentDefinition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "executionConfig" JSONB NOT NULL DEFAULT '{"version":1}',
    "definitionRevision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentDefinition_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AgentDefinition" ("createdAt", "executionConfig", "id", "instructions", "isEnabled", "name", "projectId", "updatedAt") SELECT "createdAt", "executionConfig", "id", "instructions", "isEnabled", "name", "projectId", "updatedAt" FROM "AgentDefinition";
DROP TABLE "AgentDefinition";
ALTER TABLE "new_AgentDefinition" RENAME TO "AgentDefinition";
CREATE INDEX "AgentDefinition_projectId_isEnabled_idx" ON "AgentDefinition"("projectId", "isEnabled");
CREATE TABLE "new_AgentTrigger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentDefinitionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "connectionId" TEXT,
    "description" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "filterInstructions" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "triggerRevision" INTEGER NOT NULL DEFAULT 1,
    "activationGeneration" INTEGER NOT NULL DEFAULT 0,
    "activationState" TEXT NOT NULL DEFAULT 'PAUSED',
    "activationBoundary" JSONB,
    "pendingActivation" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentTrigger_agentDefinitionId_fkey" FOREIGN KEY ("agentDefinitionId") REFERENCES "AgentDefinition" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentTrigger_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AgentConnection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_AgentTrigger" ("agentDefinitionId", "config", "connectionId", "createdAt", "description", "filterInstructions", "id", "isEnabled", "type", "updatedAt") SELECT "agentDefinitionId", "config", "connectionId", "createdAt", "description", "filterInstructions", "id", "isEnabled", "type", "updatedAt" FROM "AgentTrigger";
DROP TABLE "AgentTrigger";
ALTER TABLE "new_AgentTrigger" RENAME TO "AgentTrigger";
CREATE INDEX "AgentTrigger_agentDefinitionId_isEnabled_idx" ON "AgentTrigger"("agentDefinitionId", "isEnabled");
CREATE INDEX "AgentTrigger_connectionId_type_isEnabled_idx" ON "AgentTrigger"("connectionId", "type", "isEnabled");
CREATE UNIQUE INDEX "AgentTrigger_id_agentDefinitionId_key" ON "AgentTrigger"("id", "agentDefinitionId");
CREATE UNIQUE INDEX "AgentTrigger_id_agentDefinitionId_connectionId_key" ON "AgentTrigger"("id", "agentDefinitionId", "connectionId");
CREATE TABLE "new_AgentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentDefinitionId" TEXT NOT NULL,
    "triggerId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "eventId" TEXT,
    "definitionRevision" INTEGER NOT NULL DEFAULT 1,
    "triggerRevision" INTEGER NOT NULL DEFAULT 1,
    "activationGeneration" INTEGER NOT NULL DEFAULT 0,
    "launchPhase" TEXT NOT NULL DEFAULT 'RESERVED',
    "reservedWorkspaceId" TEXT,
    "reservedSessionId" TEXT,
    "initialMessageId" TEXT,
    "workerGeneration" INTEGER NOT NULL DEFAULT 0,
    "attemptGeneration" INTEGER NOT NULL DEFAULT 1,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME,
    "leaseExpiresAt" DATETIME,
    "expiresAt" DATETIME,
    "reasonCode" TEXT,
    "result" JSONB,
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
    CONSTRAINT "AgentRun_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "AgentEvent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AgentRun" ("agentDefinitionId", "completedAt", "createdAt", "definitionSnapshot", "errorMessage", "id", "idempotencyKey", "input", "startedAt", "status", "triggerId", "triggerSnapshot", "workspaceId") SELECT "agentDefinitionId", "completedAt", "createdAt", "definitionSnapshot", "errorMessage", "id", "idempotencyKey", "input", "startedAt", "status", "triggerId", "triggerSnapshot", "workspaceId" FROM "AgentRun";
DROP TABLE "AgentRun";
ALTER TABLE "new_AgentRun" RENAME TO "AgentRun";
CREATE UNIQUE INDEX "AgentRun_reservedWorkspaceId_key" ON "AgentRun"("reservedWorkspaceId");
CREATE UNIQUE INDEX "AgentRun_reservedSessionId_key" ON "AgentRun"("reservedSessionId");
CREATE UNIQUE INDEX "AgentRun_initialMessageId_key" ON "AgentRun"("initialMessageId");
CREATE UNIQUE INDEX "AgentRun_workspaceId_key" ON "AgentRun"("workspaceId");
CREATE INDEX "AgentRun_eventId_idx" ON "AgentRun"("eventId");
CREATE INDEX "AgentRun_agentDefinitionId_createdAt_idx" ON "AgentRun"("agentDefinitionId", "createdAt");
CREATE INDEX "AgentRun_triggerId_agentDefinitionId_idx" ON "AgentRun"("triggerId", "agentDefinitionId");
CREATE INDEX "AgentRun_status_createdAt_idx" ON "AgentRun"("status", "createdAt");
CREATE UNIQUE INDEX "AgentRun_agentDefinitionId_idempotencyKey_key" ON "AgentRun"("agentDefinitionId", "idempotencyKey");
CREATE UNIQUE INDEX "AgentRun_agentDefinitionId_eventId_key" ON "AgentRun"("agentDefinitionId", "eventId");
CREATE UNIQUE INDEX "AgentRun_id_agentDefinitionId_eventId_key" ON "AgentRun"("id", "agentDefinitionId", "eventId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "AgentEvent_payloadExpiresAt_idx" ON "AgentEvent"("payloadExpiresAt");

-- CreateIndex
CREATE INDEX "AgentEvent_identityExpiresAt_idx" ON "AgentEvent"("identityExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentEvent_connectionId_providerEventId_key" ON "AgentEvent"("connectionId", "providerEventId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentEvent_connectionId_sourceOrder_key" ON "AgentEvent"("connectionId", "sourceOrder");

-- CreateIndex
CREATE UNIQUE INDEX "AgentEvent_id_connectionId_key" ON "AgentEvent"("id", "connectionId");

-- CreateIndex
CREATE INDEX "AgentEvaluation_eventId_connectionId_idx" ON "AgentEvaluation"("eventId", "connectionId");

-- CreateIndex
CREATE INDEX "AgentEvaluation_triggerId_agentDefinitionId_connectionId_idx" ON "AgentEvaluation"("triggerId", "agentDefinitionId", "connectionId");

-- CreateIndex
CREATE INDEX "AgentEvaluation_agentDefinitionId_createdAt_idx" ON "AgentEvaluation"("agentDefinitionId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentEvaluation_runId_agentDefinitionId_eventId_idx" ON "AgentEvaluation"("runId", "agentDefinitionId", "eventId");

-- CreateIndex
CREATE INDEX "AgentEvaluation_expiresAt_idx" ON "AgentEvaluation"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentEvaluation_eventId_triggerId_definitionRevision_triggerRevision_activationGeneration_key" ON "AgentEvaluation"("eventId", "triggerId", "definitionRevision", "triggerRevision", "activationGeneration");

-- CreateIndex
CREATE UNIQUE INDEX "AgentInitialDelivery_runId_key" ON "AgentInitialDelivery"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentInitialDelivery_sendAttemptId_key" ON "AgentInitialDelivery"("sendAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentInitialDelivery_messageId_key" ON "AgentInitialDelivery"("messageId");

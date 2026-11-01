-- DropIndex
DROP INDEX "AgentTrigger_id_agentDefinitionId_connectionId_key";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentEvaluation" (
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
    CONSTRAINT "AgentEvaluation_triggerId_agentDefinitionId_fkey" FOREIGN KEY ("triggerId", "agentDefinitionId") REFERENCES "AgentTrigger" ("id", "agentDefinitionId") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "AgentEvaluation_runId_agentDefinitionId_eventId_fkey" FOREIGN KEY ("runId", "agentDefinitionId", "eventId") REFERENCES "AgentRun" ("id", "agentDefinitionId", "eventId") ON DELETE NO ACTION ON UPDATE NO ACTION
);
INSERT INTO "new_AgentEvaluation" ("activationGeneration", "agentDefinitionId", "classifier", "configurationSnapshot", "connectionId", "createdAt", "definitionRevision", "eventId", "expiresAt", "explanation", "id", "reasonCode", "runId", "status", "triggerId", "triggerRevision", "updatedAt") SELECT "activationGeneration", "agentDefinitionId", "classifier", "configurationSnapshot", "connectionId", "createdAt", "definitionRevision", "eventId", "expiresAt", "explanation", "id", "reasonCode", "runId", "status", "triggerId", "triggerRevision", "updatedAt" FROM "AgentEvaluation";
DROP TABLE "AgentEvaluation";
ALTER TABLE "new_AgentEvaluation" RENAME TO "AgentEvaluation";
CREATE INDEX "AgentEvaluation_eventId_connectionId_idx" ON "AgentEvaluation"("eventId", "connectionId");
CREATE INDEX "AgentEvaluation_triggerId_agentDefinitionId_idx" ON "AgentEvaluation"("triggerId", "agentDefinitionId");
CREATE INDEX "AgentEvaluation_agentDefinitionId_createdAt_idx" ON "AgentEvaluation"("agentDefinitionId", "createdAt");
CREATE INDEX "AgentEvaluation_runId_agentDefinitionId_eventId_idx" ON "AgentEvaluation"("runId", "agentDefinitionId", "eventId");
CREATE INDEX "AgentEvaluation_expiresAt_idx" ON "AgentEvaluation"("expiresAt");
CREATE UNIQUE INDEX "AgentEvaluation_eventId_triggerId_definitionRevision_triggerRevision_activationGeneration_key" ON "AgentEvaluation"("eventId", "triggerId", "definitionRevision", "triggerRevision", "activationGeneration");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

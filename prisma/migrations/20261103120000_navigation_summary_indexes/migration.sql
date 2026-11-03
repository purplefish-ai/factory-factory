-- Navigation summaries poll the newest terminal outcome per agent every 10
-- seconds. Index exactly that ordering so lookups stop sorting all history.

-- Prisma cannot express partial expression indexes and ignores this one during
-- SQLite diffing. Keep the predicate and ORDER BY in sync with
-- agentManagementHistoryAccessor.navigationSummary.
CREATE INDEX "AgentRun_latest_terminal_idx" ON "AgentRun"("agentDefinitionId", COALESCE("completedAt", "createdAt") DESC, "id" DESC) WHERE "triggerId" IS NOT NULL AND "status" IN ('COMPLETED', 'PR_CREATED', 'FAILED', 'CANCELLED');

-- DropIndex
DROP INDEX "PeriodicTaskExecution_periodicTaskId_idx";

-- CreateIndex
CREATE INDEX "PeriodicTaskExecution_periodicTaskId_startedAt_id_idx" ON "PeriodicTaskExecution"("periodicTaskId", "startedAt", "id");

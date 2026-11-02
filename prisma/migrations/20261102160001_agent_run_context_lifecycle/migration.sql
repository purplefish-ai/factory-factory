-- Existing context stays retained. Only an explicitly enabled maintenance policy expires it.
ALTER TABLE "AgentRun" ADD COLUMN "contextExpiredAt" DATETIME;
CREATE INDEX "AgentRun_contextExpiredAt_completedAt_idx" ON "AgentRun"("contextExpiredAt", "completedAt");

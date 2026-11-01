ALTER TABLE "AgentEvaluation" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AgentEvaluation" ADD COLUMN "nextAttemptAt" DATETIME;

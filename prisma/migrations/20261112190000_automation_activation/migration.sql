-- Enable persists the execution intent it validated, scoped to a definition
-- revision. Activation and admission refuse a definition without a current one.
ALTER TABLE "AgentDefinition" ADD COLUMN "validatedIntent" JSONB;

-- A STARTING trigger that cannot complete returns to PAUSED with this reason.
ALTER TABLE "AgentTrigger" ADD COLUMN "pausedReasonCode" TEXT;

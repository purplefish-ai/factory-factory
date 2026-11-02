ALTER TABLE "AgentDefinition" ADD COLUMN "managementRevision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AgentTrigger" ADD COLUMN "isConfigured" BOOLEAN;

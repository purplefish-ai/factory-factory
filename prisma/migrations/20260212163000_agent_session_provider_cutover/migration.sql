-- Phase 3 provider-aware session model cutover.
-- Replaces ClaudeSession storage with unified AgentSession while preserving IDs/timestamps.

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- Add provider-default resolution fields.
ALTER TABLE "Workspace" ADD COLUMN "defaultSessionProvider" TEXT NOT NULL DEFAULT 'WORKSPACE_DEFAULT';
ALTER TABLE "Workspace" ADD COLUMN "ratchetSessionProvider" TEXT NOT NULL DEFAULT 'WORKSPACE_DEFAULT';
ALTER TABLE "UserSettings" ADD COLUMN "defaultSessionProvider" TEXT NOT NULL DEFAULT 'CLAUDE';

-- Create unified provider-aware session table.
CREATE TABLE "AgentSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT,
    "workflow" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'sonnet',
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "provider" TEXT NOT NULL,
    "providerSessionId" TEXT,
    "providerProjectPath" TEXT,
    "providerProcessPid" INTEGER,
    "providerMetadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentSession_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Locked backfill mapping from #960.
INSERT INTO "AgentSession" (
    "id",
    "workspaceId",
    "name",
    "workflow",
    "model",
    "status",
    "provider",
    "providerSessionId",
    "providerProjectPath",
    "providerProcessPid",
    "providerMetadata",
    "createdAt",
    "updatedAt"
)
SELECT
    "id",
    "workspaceId",
    "name",
    "workflow",
    "model",
    "status",
    'CLAUDE',
    "claudeSessionId",
    "claudeProjectPath",
    "claudeProcessPid",
    NULL,
    "createdAt",
    "updatedAt"
FROM "ClaudeSession";

-- Migration safety checks: row counts + field mapping correctness.
CREATE TEMP TABLE "_migration_verify_row_counts" (
    "sourceCount" INTEGER NOT NULL,
    "targetCount" INTEGER NOT NULL,
    CHECK ("sourceCount" = "targetCount")
);
INSERT INTO "_migration_verify_row_counts" ("sourceCount", "targetCount")
SELECT (SELECT COUNT(*) FROM "ClaudeSession"), (SELECT COUNT(*) FROM "AgentSession");

CREATE TEMP TABLE "_migration_verify_locked_mapping" (
    "isValid" INTEGER NOT NULL,
    CHECK ("isValid" = 1)
);
INSERT INTO "_migration_verify_locked_mapping" ("isValid")
SELECT CASE
  WHEN (
    SELECT COUNT(*)
    FROM "ClaudeSession" c
    JOIN "AgentSession" a ON a."id" = c."id"
    WHERE a."workspaceId" = c."workspaceId"
      AND a."name" IS c."name"
      AND a."workflow" = c."workflow"
      AND a."model" = c."model"
      AND a."status" = c."status"
      AND a."provider" = 'CLAUDE'
      AND a."providerSessionId" IS c."claudeSessionId"
      AND a."providerProjectPath" IS c."claudeProjectPath"
      AND a."providerProcessPid" IS c."claudeProcessPid"
      AND a."providerMetadata" IS NULL
      AND a."createdAt" = c."createdAt"
      AND a."updatedAt" = c."updatedAt"
  ) = (SELECT COUNT(*) FROM "ClaudeSession")
  THEN 1
  ELSE 0
END;

DROP TABLE "_migration_verify_row_counts";
DROP TABLE "_migration_verify_locked_mapping";

-- Required indexes for first cutover.
CREATE INDEX "AgentSession_workspaceId_idx" ON "AgentSession"("workspaceId");
CREATE INDEX "AgentSession_status_idx" ON "AgentSession"("status");
CREATE INDEX "AgentSession_provider_idx" ON "AgentSession"("provider");
CREATE INDEX "AgentSession_workspaceId_provider_idx" ON "AgentSession"("workspaceId", "provider");

-- Remove legacy table after successful backfill checks.
DROP TABLE "ClaudeSession";

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

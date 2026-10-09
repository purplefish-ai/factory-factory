-- Keep exact legacy identities until their retained transcripts are confirmed.
ALTER TABLE "WorkspacePRMonitoring" ADD COLUMN "legacySessionIds" JSONB NOT NULL DEFAULT '[]';
UPDATE "WorkspacePRMonitoring" SET "legacySessionIds" = (
  SELECT json_group_array(id) FROM (
    SELECT id FROM "AgentSession" WHERE "workspaceId" = "WorkspacePRMonitoring"."workspaceId" AND workflow = 'ratchet'
    UNION
    SELECT "activeSessionId" AS id FROM "WorkspaceRatchet" WHERE "workspaceId" = "WorkspacePRMonitoring"."workspaceId" AND "activeSessionId" IS NOT NULL
  )
);
-- Observation/config/event data was copied by the additive ledger migration.
-- AgentSession and ClosedSession records remain intact. Startup archives and
-- retires only legacy workflow=ratchet sessions before enabling event delivery.
UPDATE "WorkspacePRMonitoring" SET "deliveryPauseReason" = 'LEGACY_FIXER'
WHERE "workspaceId" IN (SELECT "workspaceId" FROM "AgentSession" WHERE "workflow" = 'ratchet');
ALTER TABLE "UserSettings" RENAME COLUMN "ratchetPermissions" TO "autoIterationPermissions";
ALTER TABLE "Workspace" DROP COLUMN "ratchetSessionProvider";
DROP TABLE "WorkspacePRRatchet";
DROP TABLE "WorkspaceRatchet";

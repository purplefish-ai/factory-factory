-- Retire only loop configuration and runtime metadata. Workspace rows,
-- AgentSession transcripts/identities and all worktree/code references remain.
DROP TABLE "WorkspaceAutoIteration";
ALTER TABLE "UserSettings" DROP COLUMN "autoIterationPermissions";

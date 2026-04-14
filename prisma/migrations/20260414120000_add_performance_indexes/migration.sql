-- Add performance indexes for common query patterns

-- Project: cover list query (filter isArchived + sort by updatedAt)
CREATE INDEX "Project_isArchived_updatedAt_idx" ON "Project"("isArchived", "updatedAt");

-- Workspace: cover project view load (filter projectId + sort by updatedAt/createdAt)
CREATE INDEX "Workspace_projectId_updatedAt_idx" ON "Workspace"("projectId", "updatedAt");
CREATE INDEX "Workspace_projectId_createdAt_idx" ON "Workspace"("projectId", "createdAt");

-- Workspace: cover PR sync scheduler (filter status + prUrl/prUpdatedAt)
CREATE INDEX "Workspace_status_prUrl_idx" ON "Workspace"("status", "prUrl");
CREATE INDEX "Workspace_status_prUpdatedAt_idx" ON "Workspace"("status", "prUpdatedAt");

-- Workspace: cover ratchet polling loop (filter status + ratchetEnabled + sort ratchetLastCheckedAt)
CREATE INDEX "Workspace_status_ratchetEnabled_ratchetLastCheckedAt_idx" ON "Workspace"("status", "ratchetEnabled", "ratchetLastCheckedAt");

-- AgentSession: cover session queries sorted by createdAt/updatedAt, and status filter within workspace
CREATE INDEX "AgentSession_workspaceId_status_idx" ON "AgentSession"("workspaceId", "status");
CREATE INDEX "AgentSession_workspaceId_createdAt_idx" ON "AgentSession"("workspaceId", "createdAt");
CREATE INDEX "AgentSession_workspaceId_updatedAt_idx" ON "AgentSession"("workspaceId", "updatedAt");

-- TerminalSession: cover session queries sorted by updatedAt within workspace
CREATE INDEX "TerminalSession_workspaceId_updatedAt_idx" ON "TerminalSession"("workspaceId", "updatedAt");

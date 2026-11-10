-- The pr-event-retention prune filters on state and createdAt across all
-- workspaces, so the (workspaceId, state, createdAt) index cannot serve it.
-- Without this index the prune scans every unbound row and sorts it.

-- CreateIndex
CREATE INDEX "WorkspacePREvent_state_createdAt_idx" ON "WorkspacePREvent"("state", "createdAt");

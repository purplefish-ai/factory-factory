-- CreateIndex
CREATE INDEX "Workspace_projectId_status_idx" ON "Workspace"("projectId", "status");

-- CreateIndex
CREATE INDEX "Workspace_projectId_cachedKanbanColumn_idx" ON "Workspace"("projectId", "cachedKanbanColumn");

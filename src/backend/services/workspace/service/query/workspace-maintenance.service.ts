import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import { workspacePrAccessor } from '@/backend/services/workspace/resources/workspace-pr.accessor';

class WorkspaceMaintenanceService {
  findNeedingWorktree() {
    return workspaceAccessor.findNeedingWorktree();
  }

  findStaleArchiving() {
    return workspaceAccessor.findStaleArchivingWithProject();
  }

  findNeedingPRSync(staleThresholdMinutes?: number) {
    return workspacePrAccessor.findNeedingSync(staleThresholdMinutes);
  }

  findNeedingPRDiscovery(limit: number, dueAt = new Date()) {
    return workspacePrAccessor.findNeedingDiscovery(limit, dueAt);
  }

  claimPRDiscoveryAttempt(
    id: string,
    attempt: Parameters<typeof workspacePrAccessor.claimDiscoveryAttempt>[1]
  ) {
    return workspacePrAccessor.claimDiscoveryAttempt(id, attempt);
  }

  findActiveWithSessionsAndProject() {
    return workspaceAccessor.findAllNonArchivedWithSessionsAndProject();
  }
}

export const workspaceMaintenanceService = new WorkspaceMaintenanceService();

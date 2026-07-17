import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';

class WorkspaceMaintenanceService {
  findNeedingWorktree() {
    return workspaceAccessor.findNeedingWorktree();
  }

  findStaleArchiving() {
    return workspaceAccessor.findStaleArchivingWithProject();
  }

  findNeedingPRSync(staleThresholdMinutes?: number) {
    return workspaceAccessor.findNeedingPRSync(staleThresholdMinutes);
  }

  findNeedingPRDiscovery(limit: number, dueAt = new Date()) {
    return workspaceAccessor.findNeedingPRDiscovery(limit, dueAt);
  }

  claimPRDiscoveryAttempt(
    id: string,
    attempt: Parameters<typeof workspaceAccessor.claimPRDiscoveryAttempt>[1]
  ) {
    return workspaceAccessor.claimPRDiscoveryAttempt(id, attempt);
  }

  findActiveWithSessionsAndProject() {
    return workspaceAccessor.findAllNonArchivedWithSessionsAndProject();
  }
}

export const workspaceMaintenanceService = new WorkspaceMaintenanceService();

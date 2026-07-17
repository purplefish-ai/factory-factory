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

  findNeedingPRDiscovery() {
    return workspaceAccessor.findNeedingPRDiscovery();
  }

  findActiveWithSessionsAndProject() {
    return workspaceAccessor.findAllNonArchivedWithSessionsAndProject();
  }
}

export const workspaceMaintenanceService = new WorkspaceMaintenanceService();

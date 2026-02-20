import { createLogger } from '@/backend/services/logger.service';

const logger = createLogger('workspace-archive-tracker');

class WorkspaceArchiveTrackerService {
  private readonly archivingWorkspaceIds = new Set<string>();

  markArchiving(workspaceId: string): void {
    this.archivingWorkspaceIds.add(workspaceId);
    logger.debug('Workspace marked as archiving', { workspaceId });
  }

  clearArchiving(workspaceId: string): void {
    if (!this.archivingWorkspaceIds.has(workspaceId)) {
      return;
    }
    this.archivingWorkspaceIds.delete(workspaceId);
    logger.debug('Workspace cleared from archiving set', { workspaceId });
  }

  isArchiving(workspaceId: string): boolean {
    return this.archivingWorkspaceIds.has(workspaceId);
  }

  reset(): void {
    this.archivingWorkspaceIds.clear();
  }
}

export const workspaceArchiveTrackerService = new WorkspaceArchiveTrackerService();

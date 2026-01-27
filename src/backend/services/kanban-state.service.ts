import { KanbanColumn, PRState, type Workspace, WorkspaceStatus } from '@prisma-gen/client';
import { workspaceAccessor } from '../resource_accessors/index';
import { createLogger } from './logger.service';
import { sessionService } from './session.service';

const logger = createLogger('kanban-state');

export interface KanbanStateInput {
  lifecycle: WorkspaceStatus;
  isWorking: boolean;
  prState: PRState;
  hasHadSessions: boolean;
}

export interface WorkspaceWithKanbanState {
  workspace: Workspace;
  kanbanColumn: KanbanColumn;
  isWorking: boolean;
}

/**
 * Pure function to compute kanban column from workspace state.
 * This is the core derivation logic for the kanban board.
 */
export function computeKanbanColumn(input: KanbanStateInput): KanbanColumn {
  const { lifecycle, isWorking, prState, hasHadSessions } = input;

  // Done: User explicitly marked complete or archived
  if (lifecycle === WorkspaceStatus.COMPLETED || lifecycle === WorkspaceStatus.ARCHIVED) {
    return KanbanColumn.DONE;
  }

  // In Progress: Any active work (overrides PR state)
  if (isWorking) {
    return KanbanColumn.IN_PROGRESS;
  }

  // Merged: PR merged but not marked done
  if (prState === PRState.MERGED) {
    return KanbanColumn.MERGED;
  }

  // Approved: PR approved, waiting to merge
  if (prState === PRState.APPROVED) {
    return KanbanColumn.APPROVED;
  }

  // PR Open: PR exists in review state
  if (
    prState === PRState.DRAFT ||
    prState === PRState.OPEN ||
    prState === PRState.CHANGES_REQUESTED
  ) {
    return KanbanColumn.PR_OPEN;
  }

  // Closed PRs without merge go back to waiting/backlog
  // (prState === CLOSED or NONE at this point)

  // Backlog: Never had any sessions
  if (!hasHadSessions) {
    return KanbanColumn.BACKLOG;
  }

  // Waiting: Had sessions but idle with no active PR
  return KanbanColumn.WAITING;
}

class KanbanStateService {
  /**
   * Get kanban state for a single workspace, including real-time activity check.
   */
  async getWorkspaceKanbanState(workspaceId: string): Promise<WorkspaceWithKanbanState | null> {
    const workspace = await workspaceAccessor.findById(workspaceId);
    if (!workspace) {
      return null;
    }

    // Get real-time working status from session service
    const sessionIds = workspace.claudeSessions?.map((s) => s.id) ?? [];
    const isWorking = sessionService.isAnySessionWorking(sessionIds);

    const kanbanColumn = computeKanbanColumn({
      lifecycle: workspace.status,
      isWorking,
      prState: workspace.prState,
      hasHadSessions: workspace.hasHadSessions,
    });

    return {
      workspace,
      kanbanColumn,
      isWorking,
    };
  }

  /**
   * Get kanban states for multiple workspaces (batch operation for list view).
   * Uses cached kanban column for non-working workspaces for performance.
   */
  getWorkspacesKanbanStates(
    workspaces: Workspace[],
    workingStatusMap: Map<string, boolean>
  ): WorkspaceWithKanbanState[] {
    return workspaces.map((workspace) => {
      const isWorking = workingStatusMap.get(workspace.id) ?? false;

      // Compute live kanban column (real-time activity overlays cached PR state)
      const kanbanColumn = computeKanbanColumn({
        lifecycle: workspace.status,
        isWorking,
        prState: workspace.prState,
        hasHadSessions: workspace.hasHadSessions,
      });

      return {
        workspace,
        kanbanColumn,
        isWorking,
      };
    });
  }

  /**
   * Update the cached kanban column for a workspace.
   * Called after PR state changes or other relevant updates.
   */
  async updateCachedKanbanColumn(workspaceId: string): Promise<void> {
    const workspace = await workspaceAccessor.findById(workspaceId);
    if (!workspace) {
      logger.warn('Cannot update cached kanban column: workspace not found', { workspaceId });
      return;
    }

    // For cached column, assume not working (real-time overlay handles working state)
    const cachedColumn = computeKanbanColumn({
      lifecycle: workspace.status,
      isWorking: false,
      prState: workspace.prState,
      hasHadSessions: workspace.hasHadSessions,
    });

    await workspaceAccessor.update(workspaceId, {
      cachedKanbanColumn: cachedColumn,
      stateComputedAt: new Date(),
    });

    logger.debug('Updated cached kanban column', { workspaceId, cachedColumn });
  }

  /**
   * Batch update cached kanban columns for multiple workspaces.
   * Updates are performed in parallel for better performance.
   */
  async updateCachedKanbanColumns(workspaceIds: string[]): Promise<void> {
    await Promise.all(workspaceIds.map((id) => this.updateCachedKanbanColumn(id)));
  }
}

export const kanbanStateService = new KanbanStateService();

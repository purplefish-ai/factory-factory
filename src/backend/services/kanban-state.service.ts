import { KanbanColumn, PRState, type Workspace, WorkspaceStatus } from '@prisma-gen/client';
import { workspaceAccessor } from '../resource_accessors/index';
import { createLogger } from './logger.service';
import { sessionService } from './session.service';
import { deriveWorkspaceFlowState } from './workspace-flow-state.service';

const logger = createLogger('kanban-state');

export interface KanbanStateInput {
  lifecycle: WorkspaceStatus;
  isWorking: boolean;
  prState: PRState;
  hasHadSessions: boolean;
}

export interface WorkspaceWithKanbanState {
  workspace: Workspace;
  kanbanColumn: KanbanColumn | null;
  isWorking: boolean;
}

/**
 * Pure function to compute kanban column from workspace state.
 * This is the core derivation logic for the kanban board.
 *
 * Simplified 3-column model:
 * - WORKING: Initializing states (NEW/PROVISIONING/FAILED) or actively working
 * - WAITING: Idle workspaces with hasHadSessions=true (includes PR states)
 * - DONE: PR merged
 *
 * Note: Workspaces with hasHadSessions=false AND status=READY are hidden from view.
 * Archived workspaces retain their pre-archive cachedKanbanColumn and are hidden
 * unless "Show Archived" toggle is enabled.
 *
 * Returns null for workspaces that should be hidden (READY + no sessions).
 */
export function computeKanbanColumn(input: KanbanStateInput): KanbanColumn | null {
  const { lifecycle, isWorking, prState, hasHadSessions } = input;

  // Archived workspaces: return null - they use cachedKanbanColumn from before archiving
  // The caller should handle archived workspaces separately
  if (lifecycle === WorkspaceStatus.ARCHIVED) {
    return null;
  }

  // WORKING: Initializing states (not ready for work yet) or actively working
  if (
    lifecycle === WorkspaceStatus.NEW ||
    lifecycle === WorkspaceStatus.PROVISIONING ||
    lifecycle === WorkspaceStatus.FAILED ||
    isWorking
  ) {
    return KanbanColumn.WORKING;
  }

  // From here, lifecycle === READY and not working

  // DONE: PR merged
  if (prState === PRState.MERGED) {
    return KanbanColumn.DONE;
  }

  // Hide workspaces that never had sessions (old BACKLOG items)
  // These are filtered out from the kanban view
  if (!hasHadSessions) {
    return null;
  }

  // WAITING: Everything else - idle workspaces with sessions
  // (includes PR states: NONE, DRAFT, OPEN, CHANGES_REQUESTED, APPROVED, CLOSED)
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
    const isSessionWorking = sessionService.isAnySessionWorking(sessionIds);
    const flowState = deriveWorkspaceFlowState({
      prUrl: workspace.prUrl,
      prState: workspace.prState,
      prCiStatus: workspace.prCiStatus,
      prUpdatedAt: workspace.prUpdatedAt,
      ratchetEnabled: workspace.ratchetEnabled,
      ratchetState: workspace.ratchetState,
    });
    const isWorking = isSessionWorking || flowState.isWorking;

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
      const flowState = deriveWorkspaceFlowState({
        prUrl: workspace.prUrl,
        prState: workspace.prState,
        prCiStatus: workspace.prCiStatus,
        prUpdatedAt: workspace.prUpdatedAt,
        ratchetEnabled: workspace.ratchetEnabled,
        ratchetState: workspace.ratchetState,
      });
      const effectiveWorking = isWorking || flowState.isWorking;

      // Compute live kanban column (real-time activity overlays cached PR state)
      const kanbanColumn = computeKanbanColumn({
        lifecycle: workspace.status,
        isWorking: effectiveWorking,
        prState: workspace.prState,
        hasHadSessions: workspace.hasHadSessions,
      });

      return {
        workspace,
        kanbanColumn,
        isWorking: effectiveWorking,
      };
    });
  }

  /**
   * Update the cached kanban column for a workspace.
   * Called after PR state changes or other relevant updates.
   *
   * Note: For archived workspaces, the cachedKanbanColumn is preserved
   * to show the column it was in before archiving.
   * Only updates stateComputedAt when the column actually changes.
   */
  async updateCachedKanbanColumn(workspaceId: string): Promise<void> {
    const workspace = await workspaceAccessor.findById(workspaceId);
    if (!workspace) {
      logger.warn('Cannot update cached kanban column: workspace not found', { workspaceId });
      return;
    }

    // Don't update cached column for archived workspaces - preserve pre-archive state
    if (workspace.status === WorkspaceStatus.ARCHIVED) {
      return;
    }

    const flowState = deriveWorkspaceFlowState({
      prUrl: workspace.prUrl,
      prState: workspace.prState,
      prCiStatus: workspace.prCiStatus,
      prUpdatedAt: workspace.prUpdatedAt,
      ratchetEnabled: workspace.ratchetEnabled,
      ratchetState: workspace.ratchetState,
    });

    // For cached column, include flow-state working but not in-memory session activity.
    const cachedColumn = computeKanbanColumn({
      lifecycle: workspace.status,
      isWorking: flowState.isWorking,
      prState: workspace.prState,
      hasHadSessions: workspace.hasHadSessions,
    });

    // If column is null (hidden workspace), default to WAITING for the cache
    const newColumn = cachedColumn ?? KanbanColumn.WAITING;

    // Only update stateComputedAt if the column actually changed
    const columnChanged = workspace.cachedKanbanColumn !== newColumn;
    await workspaceAccessor.update(workspaceId, {
      cachedKanbanColumn: newColumn,
      ...(columnChanged && { stateComputedAt: new Date() }),
    });

    logger.debug('Updated cached kanban column', { workspaceId, cachedColumn, columnChanged });
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

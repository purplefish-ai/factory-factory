import { KanbanColumn, WorkspaceStatus } from '@factory-factory/core';
import type { Workspace } from '@prisma-gen/client';
import type { WorkspaceSessionBridge } from '@/backend/domains/workspace/bridges';
import { workspaceAccessor } from '@/backend/resource_accessors/index';
import { createLogger } from '@/backend/services/logger.service';
import { deriveWorkspaceFlowStateFromWorkspace } from './flow-state';
import { deriveWorkspaceRuntimeState } from './workspace-runtime-state';

export { computeKanbanColumn, type KanbanStateInput } from '@factory-factory/core';

import { computeKanbanColumn } from '@factory-factory/core';

const logger = createLogger('kanban-state');

export interface WorkspaceWithKanbanState {
  workspace: Workspace;
  kanbanColumn: KanbanColumn | null;
  isWorking: boolean;
}

class KanbanStateService {
  private sessionBridge: WorkspaceSessionBridge | null = null;

  configure(bridges: { session: WorkspaceSessionBridge }): void {
    this.sessionBridge = bridges.session;
  }

  private get session(): WorkspaceSessionBridge {
    if (!this.sessionBridge) {
      throw new Error(
        'KanbanStateService not configured: session bridge missing. Call configure() first.'
      );
    }
    return this.sessionBridge;
  }

  /**
   * Get kanban state for a single workspace, including real-time activity check.
   */
  async getWorkspaceKanbanState(workspaceId: string): Promise<WorkspaceWithKanbanState | null> {
    const workspace = await workspaceAccessor.findById(workspaceId);
    if (!workspace) {
      return null;
    }

    const runtimeState = deriveWorkspaceRuntimeState(workspace, (sessionIds) =>
      this.session.isAnySessionWorking(sessionIds)
    );

    const kanbanColumn = computeKanbanColumn({
      lifecycle: workspace.status,
      isWorking: runtimeState.isWorking,
      prState: workspace.prState,
      hasHadSessions: workspace.hasHadSessions,
    });

    return {
      workspace,
      kanbanColumn,
      isWorking: runtimeState.isWorking,
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
      const runtimeState = deriveWorkspaceRuntimeState(workspace, (_sessionIds, workspaceId) => {
        return workingStatusMap.get(workspaceId) ?? false;
      });

      // Compute live kanban column (real-time activity overlays cached PR state)
      const kanbanColumn = computeKanbanColumn({
        lifecycle: workspace.status,
        isWorking: runtimeState.isWorking,
        prState: workspace.prState,
        hasHadSessions: workspace.hasHadSessions,
      });

      return {
        workspace,
        kanbanColumn,
        isWorking: runtimeState.isWorking,
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

    const flowState = deriveWorkspaceFlowStateFromWorkspace(workspace);

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

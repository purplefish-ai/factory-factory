import type { RatchetDispatchOutcome, Workspace } from '@prisma-gen/client';
import { SERVICE_THRESHOLDS } from '@/backend/services/constants';
import { createLogger } from '@/backend/services/logger.service';
import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import type { WorkspaceSessionBridge } from '@/backend/services/workspace/service/bridges';
import { KanbanColumn, PRState, RatchetState, WorkspaceStatus } from '@/shared/core';
import type { WorkspacePendingRequestType } from '@/shared/workspace-status-reason';
import { deriveWorkspaceFlowStateFromWorkspace } from './flow-state';
import { deriveWorkspaceRuntimeState } from './workspace-runtime-state';

const logger = createLogger('kanban-state');

export interface KanbanStateInput {
  lifecycle: WorkspaceStatus;
  sessionIsWorking: boolean;
  flowIsWorking: boolean;
  prState: PRState;
  ratchetState: RatchetState;
  pendingRequestType: WorkspacePendingRequestType | null;
  hasSessionRuntimeError: boolean;
  ratchetDispatchOutcome: RatchetDispatchOutcome | null;
  ratchetDispatchRetryCount: number;
}

export interface WorkspaceWithKanbanState {
  workspace: Workspace;
  kanbanColumn: KanbanColumn | null;
  isWorking: boolean;
}

/**
 * Compute the Kanban column from next-action ownership.
 *
 * - WORKING: setup, a live agent session, or PR/Ratchet automation owns the next action
 * - WAITING: a human owns the next action or automated Ratchet retries are exhausted
 * - DONE: the pull request is merged or closed
 *
 * Archived workspaces retain their pre-archive cachedKanbanColumn and are hidden
 * unless "Show Archived" toggle is enabled.
 */
export function computeKanbanColumn(input: KanbanStateInput): KanbanColumn | null {
  const { lifecycle, prState, ratchetState } = input;
  const retriesExhausted =
    input.ratchetDispatchOutcome === 'DIED' &&
    input.ratchetDispatchRetryCount >= SERVICE_THRESHOLDS.ratchetDispatchMaxRetries;

  // Archiving/archived workspaces: return null - they use cachedKanbanColumn from before archiving
  // The caller should handle archived workspaces separately
  if (lifecycle === WorkspaceStatus.ARCHIVING || lifecycle === WorkspaceStatus.ARCHIVED) {
    return null;
  }

  // DONE: PR merged or closed, as observed by either PR snapshot or ratchet monitor.
  if (
    prState === PRState.MERGED ||
    prState === PRState.CLOSED ||
    ratchetState === RatchetState.MERGED
  ) {
    return KanbanColumn.DONE;
  }

  // WAITING: Explicit errors, interactions, and exhausted retries require human attention.
  if (
    lifecycle === WorkspaceStatus.FAILED ||
    input.pendingRequestType !== null ||
    input.hasSessionRuntimeError ||
    retriesExhausted
  ) {
    return KanbanColumn.WAITING;
  }

  // WORKING: Setup, a live session, or an active PR/Ratchet flow owns the next action.
  if (
    lifecycle === WorkspaceStatus.NEW ||
    lifecycle === WorkspaceStatus.PROVISIONING ||
    input.sessionIsWorking ||
    input.flowIsWorking
  ) {
    return KanbanColumn.WORKING;
  }

  // WAITING: All remaining nonterminal workspaces require a human next action.
  return KanbanColumn.WAITING;
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
      sessionIsWorking: runtimeState.isSessionWorking,
      flowIsWorking: runtimeState.flowState.isWorking,
      prState: workspace.prState,
      ratchetState: workspace.ratchetState,
      pendingRequestType: null,
      hasSessionRuntimeError: false,
      ratchetDispatchOutcome: workspace.ratchetDispatchOutcome,
      ratchetDispatchRetryCount: workspace.ratchetDispatchRetryCount,
    });

    return {
      workspace,
      kanbanColumn,
      isWorking: runtimeState.isSessionWorking,
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
        sessionIsWorking: runtimeState.isSessionWorking,
        flowIsWorking: runtimeState.flowState.isWorking,
        prState: workspace.prState,
        ratchetState: workspace.ratchetState,
        pendingRequestType: null,
        hasSessionRuntimeError: false,
        ratchetDispatchOutcome: workspace.ratchetDispatchOutcome,
        ratchetDispatchRetryCount: workspace.ratchetDispatchRetryCount,
      });

      return {
        workspace,
        kanbanColumn,
        isWorking: runtimeState.isSessionWorking,
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
    if (
      workspace.status === WorkspaceStatus.ARCHIVING ||
      workspace.status === WorkspaceStatus.ARCHIVED
    ) {
      return;
    }

    const flowState = deriveWorkspaceFlowStateFromWorkspace(workspace);
    const cachedColumn = computeKanbanColumn({
      lifecycle: workspace.status,
      sessionIsWorking: false,
      flowIsWorking: flowState.isWorking,
      prState: workspace.prState,
      ratchetState: workspace.ratchetState,
      pendingRequestType: null,
      hasSessionRuntimeError: false,
      ratchetDispatchOutcome: workspace.ratchetDispatchOutcome,
      ratchetDispatchRetryCount: workspace.ratchetDispatchRetryCount,
    });

    // If column is null (archived workspace), default to WAITING for the cache
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

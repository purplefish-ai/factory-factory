import type { RatchetDispatchOutcome, Workspace } from '@prisma-gen/client';
import { buildWorkspaceSessionSummaries } from '@/backend/lib/session-summaries';
import { SERVICE_THRESHOLDS } from '@/backend/services/constants';
import { createLogger } from '@/backend/services/logger.service';
import {
  type WorkspaceWithSessions,
  workspaceAccessor,
} from '@/backend/services/workspace/resources/workspace.accessor';
import type { WorkspaceSessionBridge } from '@/backend/services/workspace/service/bridges';
import { KanbanColumn, PRState, RatchetState, WorkspaceStatus } from '@/shared/core';
import { findWorkspaceSessionRuntimeError } from '@/shared/session-runtime';
import type { WorkspacePendingRequestType } from '@/shared/workspace-status-reason';
import { deriveWorkspaceFlowStateFromWorkspace } from './flow-state';
import { computePendingRequestType } from './pending-request-type';
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
  private readonly cachedColumnRefreshes = new Map<string, Promise<void>>();
  private refreshGeneration = 0;
  private readonly retryWaiters = new Set<{ timer: NodeJS.Timeout; resolve: () => void }>();

  configure(bridges: { session: WorkspaceSessionBridge }): void {
    this.refreshGeneration += 1;
    for (const waiter of this.retryWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.retryWaiters.clear();
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

  private getHumanAttentionState(
    workspace: Pick<WorkspaceWithSessions, 'agentSessions'>,
    sessionIds: string[],
    pendingRequests: ReturnType<WorkspaceSessionBridge['getAllPendingRequests']>
  ): Pick<KanbanStateInput, 'pendingRequestType' | 'hasSessionRuntimeError'> {
    const sessionSummaries = buildWorkspaceSessionSummaries(workspace.agentSessions, (sessionId) =>
      this.session.getRuntimeSnapshot(sessionId)
    );

    return {
      pendingRequestType: computePendingRequestType(sessionIds, pendingRequests),
      hasSessionRuntimeError: Boolean(findWorkspaceSessionRuntimeError(sessionSummaries)),
    };
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
    const humanAttentionState = this.getHumanAttentionState(
      workspace,
      runtimeState.sessionIds,
      this.session.getAllPendingRequests()
    );

    const kanbanColumn = computeKanbanColumn({
      lifecycle: workspace.status,
      sessionIsWorking: runtimeState.isSessionWorking,
      flowIsWorking: runtimeState.flowState.isWorking,
      prState: workspace.prState,
      ratchetState: workspace.ratchetState,
      ...humanAttentionState,
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
    workspaces: WorkspaceWithSessions[],
    workingStatusMap: Map<string, boolean>
  ): WorkspaceWithKanbanState[] {
    const pendingRequests = this.session.getAllPendingRequests();

    return workspaces.map((workspace) => {
      const runtimeState = deriveWorkspaceRuntimeState(workspace, (_sessionIds, workspaceId) => {
        return workingStatusMap.get(workspaceId) ?? false;
      });
      const humanAttentionState = this.getHumanAttentionState(
        workspace,
        runtimeState.sessionIds,
        pendingRequests
      );

      // Compute live kanban column (real-time activity overlays cached PR state)
      const kanbanColumn = computeKanbanColumn({
        lifecycle: workspace.status,
        sessionIsWorking: runtimeState.isSessionWorking,
        flowIsWorking: runtimeState.flowState.isWorking,
        prState: workspace.prState,
        ratchetState: workspace.ratchetState,
        ...humanAttentionState,
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
    const generation = this.refreshGeneration;
    const previousRefresh = this.cachedColumnRefreshes.get(workspaceId) ?? Promise.resolve();
    const refresh = previousRefresh
      .catch(() => {
        // A failed refresh must not prevent a later request from reading fresh state.
      })
      .then(() => this.refreshCachedKanbanColumnWithRetry(workspaceId, generation));
    this.cachedColumnRefreshes.set(workspaceId, refresh);

    try {
      await refresh;
    } finally {
      if (this.cachedColumnRefreshes.get(workspaceId) === refresh) {
        this.cachedColumnRefreshes.delete(workspaceId);
      }
    }
  }

  private waitForRetry(attempt: number): Promise<void> {
    return new Promise((resolve) => {
      const waiter = {
        timer: setTimeout(
          () => {
            this.retryWaiters.delete(waiter);
            resolve();
          },
          10 * 2 ** attempt
        ),
        resolve,
      };
      this.retryWaiters.add(waiter);
    });
  }

  private async refreshCachedKanbanColumnWithRetry(
    workspaceId: string,
    generation: number
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (generation !== this.refreshGeneration) {
        return;
      }
      try {
        const updated = await this.refreshCachedKanbanColumn(workspaceId);
        if (updated) {
          return;
        }
      } catch (error) {
        if (generation !== this.refreshGeneration) {
          return;
        }
        if (attempt === 2) {
          throw error;
        }
        await this.waitForRetry(attempt);
      }
    }
  }

  private async refreshCachedKanbanColumn(workspaceId: string): Promise<boolean> {
    const workspace = await workspaceAccessor.findById(workspaceId);
    if (!workspace) {
      logger.warn('Cannot update cached kanban column: workspace not found', { workspaceId });
      return true;
    }

    // Don't update cached column for archived workspaces - preserve pre-archive state
    if (
      workspace.status === WorkspaceStatus.ARCHIVING ||
      workspace.status === WorkspaceStatus.ARCHIVED
    ) {
      return true;
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
    const updated = await workspaceAccessor.updateCachedKanbanColumnIfOwnershipMatches(
      workspaceId,
      {
        status: workspace.status,
        prUrl: workspace.prUrl,
        prState: workspace.prState,
        prCiStatus: workspace.prCiStatus,
        prUpdatedAt: workspace.prUpdatedAt,
        ratchetEnabled: workspace.ratchetEnabled,
        ratchetState: workspace.ratchetState,
        ratchetDispatchOutcome: workspace.ratchetDispatchOutcome,
        ratchetDispatchRetryCount: workspace.ratchetDispatchRetryCount,
        cachedKanbanColumn: workspace.cachedKanbanColumn,
      },
      {
        cachedKanbanColumn: newColumn,
        ...(columnChanged && { stateComputedAt: new Date() }),
      }
    );

    logger.debug('Updated cached kanban column', { workspaceId, cachedColumn, columnChanged });
    return updated;
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

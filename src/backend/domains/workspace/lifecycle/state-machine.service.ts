/**
 * Workspace State Machine Service
 *
 * Manages workspace status transitions with validation.
 * Ensures only valid state transitions occur and handles
 * transition-specific side effects.
 *
 * State Diagram:
 *   NEW → PROVISIONING (initialization starts)
 *   PROVISIONING → READY (success)
 *   PROVISIONING → FAILED (error)
 *   FAILED → PROVISIONING (retry startup script, with count check)
 *   FAILED → NEW (retry from scratch when worktree creation failed)
 *   READY → ARCHIVING → ARCHIVED
 *   FAILED → ARCHIVING → ARCHIVED
 *   ARCHIVING → READY/FAILED (rollback on archive failure)
 */

import { EventEmitter } from 'node:events';
import type { Prisma, Workspace } from '@prisma-gen/client';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import { createLogger } from '@/backend/services/logger.service';
import type { WorkspaceStatus } from '@/shared/core';

const logger = createLogger('workspace-state-machine');

/**
 * Valid state transitions for workspace status.
 */
const VALID_TRANSITIONS: Record<WorkspaceStatus, WorkspaceStatus[]> = {
  NEW: ['PROVISIONING'],
  PROVISIONING: ['READY', 'FAILED'],
  READY: ['ARCHIVING'],
  FAILED: ['PROVISIONING', 'NEW', 'ARCHIVING'],
  ARCHIVING: ['READY', 'FAILED', 'ARCHIVED'],
  ARCHIVED: [],
};

/**
 * Error thrown when an invalid state transition is attempted.
 */
export class WorkspaceStateMachineError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly fromStatus: WorkspaceStatus,
    public readonly toStatus: WorkspaceStatus,
    message?: string
  ) {
    super(
      message ??
        `Invalid workspace state transition: ${fromStatus} → ${toStatus} (workspace: ${workspaceId})`
    );
    this.name = 'WorkspaceStateMachineError';
  }
}

export interface TransitionOptions {
  /** Worktree path to set (for READY transition) */
  worktreePath?: string;
  /** Branch name to set (for READY transition) */
  branchName?: string;
  /** Error message to set (for FAILED transition) */
  errorMessage?: string;
}

export const WORKSPACE_STATE_CHANGED = 'workspace_state_changed' as const;

export interface WorkspaceStateChangedEvent {
  workspaceId: string;
  fromStatus: WorkspaceStatus;
  toStatus: WorkspaceStatus;
}

export interface StartProvisioningOptions {
  /** Maximum number of retries allowed (default 3) */
  maxRetries?: number;
}

type ArchivingSourceStatus = Extract<WorkspaceStatus, 'READY' | 'FAILED'>;

export interface StartArchivingResult {
  workspace: Workspace;
  previousStatus: ArchivingSourceStatus;
}

class WorkspaceStateMachineService extends EventEmitter {
  /**
   * Check if a state transition is valid.
   */
  isValidTransition(from: WorkspaceStatus, to: WorkspaceStatus): boolean {
    return VALID_TRANSITIONS[from].includes(to);
  }

  /**
   * Transition a workspace to a new status with validation.
   * Uses compare-and-swap to prevent race conditions.
   *
   * @throws WorkspaceStateMachineError if the transition is invalid or status changed
   */
  async transition(
    workspaceId: string,
    targetStatus: WorkspaceStatus,
    options?: TransitionOptions
  ): Promise<Workspace> {
    const workspace = await workspaceAccessor.findRawById(workspaceId);

    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    const currentStatus = workspace.status;

    if (!this.isValidTransition(currentStatus, targetStatus)) {
      throw new WorkspaceStateMachineError(workspaceId, currentStatus, targetStatus);
    }

    const now = new Date();
    const updateData: Prisma.WorkspaceUpdateManyMutationInput = {
      status: targetStatus,
    };

    // Apply transition-specific updates
    switch (targetStatus) {
      case 'PROVISIONING':
        updateData.initStartedAt = now;
        updateData.initErrorMessage = null;
        break;

      case 'READY':
        // Mark init completion only for PROVISIONING -> READY,
        // not for ARCHIVING rollback transitions.
        if (currentStatus === 'PROVISIONING') {
          updateData.initCompletedAt = now;
        }
        if (options?.worktreePath !== undefined) {
          updateData.worktreePath = options.worktreePath;
        }
        if (options?.branchName !== undefined) {
          updateData.branchName = options.branchName;
        }
        break;

      case 'FAILED':
        // Mark init completion only for PROVISIONING -> FAILED,
        // not for ARCHIVING rollback transitions.
        if (currentStatus === 'PROVISIONING') {
          updateData.initCompletedAt = now;
        }
        if (options?.errorMessage !== undefined) {
          updateData.initErrorMessage = options.errorMessage;
        }
        break;
    }

    // Use compare-and-swap to prevent race conditions
    const result = await workspaceAccessor.transitionWithCas(
      workspaceId,
      currentStatus,
      updateData
    );

    if (result.count === 0) {
      throw new WorkspaceStateMachineError(
        workspaceId,
        currentStatus,
        targetStatus,
        'Transition failed: status changed by another process'
      );
    }

    // Re-read workspace after successful CAS update
    const updated = await workspaceAccessor.findRawByIdOrThrow(workspaceId);

    this.emit(WORKSPACE_STATE_CHANGED, {
      workspaceId,
      fromStatus: currentStatus,
      toStatus: targetStatus,
    } satisfies WorkspaceStateChangedEvent);

    logger.debug('Workspace status transitioned', {
      workspaceId,
      from: currentStatus,
      to: targetStatus,
    });

    return updated;
  }

  /**
   * Start provisioning for a workspace.
   * Handles both initial NEW → PROVISIONING and retry FAILED → PROVISIONING transitions.
   * For retries, atomically increments the retry count and enforces max retries.
   *
   * @returns The updated workspace, or null if max retries exceeded
   */
  async startProvisioning(
    workspaceId: string,
    options?: StartProvisioningOptions
  ): Promise<Workspace | null> {
    const maxRetries = options?.maxRetries ?? 3;

    const workspace = await workspaceAccessor.findRawById(workspaceId);

    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    const currentStatus = workspace.status;

    // NEW → PROVISIONING (initial provisioning)
    if (currentStatus === 'NEW') {
      return this.transition(workspaceId, 'PROVISIONING');
    }

    // FAILED → PROVISIONING (retry)
    if (currentStatus === 'FAILED') {
      // Use atomic conditional update to check retry count
      const result = await workspaceAccessor.startProvisioningRetryIfAllowed(
        workspaceId,
        maxRetries
      );

      if (result.count === 0) {
        logger.warn('Max retries exceeded for workspace', {
          workspaceId,
          maxRetries,
          currentRetryCount: workspace.initRetryCount,
        });
        return null; // Max retries exceeded
      }

      const updated = await workspaceAccessor.findRawById(workspaceId);

      this.emit(WORKSPACE_STATE_CHANGED, {
        workspaceId,
        fromStatus: 'FAILED' as WorkspaceStatus,
        toStatus: 'PROVISIONING' as WorkspaceStatus,
      } satisfies WorkspaceStateChangedEvent);

      logger.debug('Workspace retry started', {
        workspaceId,
        retryCount: updated?.initRetryCount,
      });

      return updated;
    }

    // Invalid starting state
    throw new WorkspaceStateMachineError(
      workspaceId,
      currentStatus,
      'PROVISIONING',
      `Cannot start provisioning from status: ${currentStatus}`
    );
  }

  /**
   * Mark workspace as ready (successful initialization).
   */
  markReady(
    workspaceId: string,
    options?: Pick<TransitionOptions, 'worktreePath' | 'branchName'>
  ): Promise<Workspace> {
    return this.transition(workspaceId, 'READY', options);
  }

  /**
   * Mark workspace as failed (initialization error).
   */
  markFailed(workspaceId: string, errorMessage?: string): Promise<Workspace> {
    return this.transition(workspaceId, 'FAILED', { errorMessage });
  }

  /**
   * Mark a workspace as archiving.
   * Can only begin archiving from READY or FAILED status.
   */
  async startArchivingWithSourceStatus(workspaceId: string): Promise<StartArchivingResult> {
    const workspace = await workspaceAccessor.findRawById(workspaceId);

    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    const currentStatus = workspace.status;

    if (!(currentStatus === 'READY' || currentStatus === 'FAILED')) {
      throw new WorkspaceStateMachineError(
        workspaceId,
        currentStatus,
        'ARCHIVING',
        `Cannot start archiving from status: ${currentStatus}`
      );
    }

    const result = await workspaceAccessor.transitionWithCas(workspaceId, currentStatus, {
      status: 'ARCHIVING',
    });

    if (result.count === 0) {
      throw new WorkspaceStateMachineError(
        workspaceId,
        currentStatus,
        'ARCHIVING',
        'Transition failed: status changed by another process'
      );
    }

    const updated = await workspaceAccessor.findRawByIdOrThrow(workspaceId);

    this.emit(WORKSPACE_STATE_CHANGED, {
      workspaceId,
      fromStatus: currentStatus,
      toStatus: 'ARCHIVING',
    } satisfies WorkspaceStateChangedEvent);

    logger.debug('Workspace status transitioned', {
      workspaceId,
      from: currentStatus,
      to: 'ARCHIVING',
    });

    return {
      workspace: updated,
      previousStatus: currentStatus,
    };
  }

  startArchiving(workspaceId: string): Promise<Workspace> {
    return this.startArchivingWithSourceStatus(workspaceId).then((result) => result.workspace);
  }

  /**
   * Mark an archiving workspace as fully archived.
   */
  markArchived(workspaceId: string): Promise<Workspace> {
    return this.transition(workspaceId, 'ARCHIVED');
  }

  /**
   * Backward-compatible archive helper.
   * Expects workspace to already be in ARCHIVING state.
   */
  archive(workspaceId: string): Promise<Workspace> {
    return this.markArchived(workspaceId);
  }

  /**
   * Reset a failed workspace back to NEW state for retry.
   * Used when worktree creation itself failed (not just startup script).
   * Increments retry count to enforce max retries.
   */
  async resetToNew(workspaceId: string, maxRetries = 3): Promise<Workspace | null> {
    const workspace = await workspaceAccessor.findRawById(workspaceId);

    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    if (workspace.status !== 'FAILED') {
      throw new WorkspaceStateMachineError(
        workspaceId,
        workspace.status,
        'NEW',
        'Can only reset to NEW from FAILED status'
      );
    }

    // Use atomic conditional update to check retry count
    const result = await workspaceAccessor.resetToNewIfAllowed(workspaceId, maxRetries);

    if (result.count === 0) {
      logger.warn('Max retries exceeded for workspace reset', {
        workspaceId,
        maxRetries,
        currentRetryCount: workspace.initRetryCount,
      });
      return null; // Max retries exceeded
    }

    const updated = await workspaceAccessor.findRawById(workspaceId);

    this.emit(WORKSPACE_STATE_CHANGED, {
      workspaceId,
      fromStatus: 'FAILED' as WorkspaceStatus,
      toStatus: 'NEW' as WorkspaceStatus,
    } satisfies WorkspaceStateChangedEvent);

    logger.debug('Workspace reset to NEW for retry', {
      workspaceId,
      retryCount: updated?.initRetryCount,
    });

    return updated;
  }
}

export const workspaceStateMachine = new WorkspaceStateMachineService();

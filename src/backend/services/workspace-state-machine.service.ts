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
 *   FAILED → PROVISIONING (retry, with count check)
 *   READY → ARCHIVED
 *   FAILED → ARCHIVED
 */

import type { Workspace, WorkspaceStatus } from '@prisma-gen/client';
import { prisma } from '../db';
import { createLogger } from './logger.service';

const logger = createLogger('workspace-state-machine');

/**
 * Valid state transitions for workspace status.
 */
const VALID_TRANSITIONS: Record<WorkspaceStatus, WorkspaceStatus[]> = {
  NEW: ['PROVISIONING'],
  PROVISIONING: ['READY', 'FAILED'],
  READY: ['ARCHIVED'],
  FAILED: ['PROVISIONING', 'ARCHIVED'],
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

export interface StartProvisioningOptions {
  /** Maximum number of retries allowed (default 3) */
  maxRetries?: number;
}

class WorkspaceStateMachineService {
  /**
   * Check if a state transition is valid.
   */
  isValidTransition(from: WorkspaceStatus, to: WorkspaceStatus): boolean {
    return VALID_TRANSITIONS[from].includes(to);
  }

  /**
   * Transition a workspace to a new status with validation.
   *
   * @throws WorkspaceStateMachineError if the transition is invalid
   */
  async transition(
    workspaceId: string,
    targetStatus: WorkspaceStatus,
    options?: TransitionOptions
  ): Promise<Workspace> {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
    });

    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    const currentStatus = workspace.status;

    if (!this.isValidTransition(currentStatus, targetStatus)) {
      throw new WorkspaceStateMachineError(workspaceId, currentStatus, targetStatus);
    }

    const now = new Date();
    const updateData: Parameters<typeof prisma.workspace.update>[0]['data'] = {
      status: targetStatus,
    };

    // Apply transition-specific updates
    switch (targetStatus) {
      case 'PROVISIONING':
        updateData.initStartedAt = now;
        updateData.initErrorMessage = null;
        break;

      case 'READY':
        updateData.initCompletedAt = now;
        if (options?.worktreePath !== undefined) {
          updateData.worktreePath = options.worktreePath;
        }
        if (options?.branchName !== undefined) {
          updateData.branchName = options.branchName;
        }
        break;

      case 'FAILED':
        updateData.initCompletedAt = now;
        if (options?.errorMessage !== undefined) {
          updateData.initErrorMessage = options.errorMessage;
        }
        break;
    }

    const updated = await prisma.workspace.update({
      where: { id: workspaceId },
      data: updateData,
    });

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

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
    });

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
      const result = await prisma.workspace.updateMany({
        where: {
          id: workspaceId,
          status: 'FAILED',
          initRetryCount: { lt: maxRetries },
        },
        data: {
          status: 'PROVISIONING',
          initRetryCount: { increment: 1 },
          initStartedAt: new Date(),
          initErrorMessage: null,
        },
      });

      if (result.count === 0) {
        logger.warn('Max retries exceeded for workspace', {
          workspaceId,
          maxRetries,
          currentRetryCount: workspace.initRetryCount,
        });
        return null; // Max retries exceeded
      }

      const updated = await prisma.workspace.findUnique({ where: { id: workspaceId } });

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
   * Archive a workspace.
   * Can only archive from READY or FAILED status.
   */
  archive(workspaceId: string): Promise<Workspace> {
    return this.transition(workspaceId, 'ARCHIVED');
  }
}

export const workspaceStateMachine = new WorkspaceStateMachineService();

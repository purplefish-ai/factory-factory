/**
 * Workspace State Machine
 *
 * Centralizes all workspace status transitions using atomic compare-and-swap operations.
 * Prevents race conditions by ensuring transitions only occur from expected states.
 */

import type { Workspace, WorkspaceStatus } from '@prisma-gen/client';
import { prisma } from '../db';
import { createLogger } from './logger.service';

const logger = createLogger('WorkspaceStateMachine');

/**
 * Result of a state transition attempt
 */
export type TransitionResult =
  | { success: true; workspace: Workspace }
  | {
      success: false;
      reason: 'not_found' | 'wrong_state' | 'invalid_transition' | 'max_retries_exceeded';
      currentStatus?: WorkspaceStatus;
    };

/**
 * Valid state transitions for workspaces
 */
const VALID_TRANSITIONS: Record<WorkspaceStatus, WorkspaceStatus[]> = {
  NEW: ['PROVISIONING', 'ARCHIVED'],
  PROVISIONING: ['READY', 'FAILED', 'ARCHIVED'],
  READY: ['ARCHIVED'],
  FAILED: ['PROVISIONING', 'ARCHIVED'],
  ARCHIVED: [],
};

/**
 * Check if a transition from one status to another is valid
 */
export function isValidTransition(from: WorkspaceStatus, to: WorkspaceStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Perform an atomic state transition using compare-and-swap
 */
async function atomicTransition(
  workspaceId: string,
  fromStatus: WorkspaceStatus | WorkspaceStatus[],
  toStatus: WorkspaceStatus,
  additionalData?: Record<string, unknown>
): Promise<TransitionResult> {
  // Build the where clause for expected status(es)
  const statusCondition = Array.isArray(fromStatus) ? { in: fromStatus } : fromStatus;

  const result = await prisma.workspace.updateMany({
    where: {
      id: workspaceId,
      status: statusCondition,
    },
    data: {
      status: toStatus,
      ...additionalData,
    },
  });

  if (result.count === 0) {
    // No rows updated - either not found or wrong state
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
    });

    if (!workspace) {
      logger.warn('Transition failed: workspace not found', { workspaceId, toStatus });
      return { success: false, reason: 'not_found' };
    }

    // Check if the transition would have been invalid
    const expectedStatuses = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
    if (!expectedStatuses.some((s) => isValidTransition(s, toStatus))) {
      logger.warn('Transition failed: invalid transition', {
        workspaceId,
        fromStatus: expectedStatuses,
        toStatus,
        currentStatus: workspace.status,
      });
      return { success: false, reason: 'invalid_transition', currentStatus: workspace.status };
    }

    logger.warn('Transition failed: wrong state', {
      workspaceId,
      expectedStatus: expectedStatuses,
      currentStatus: workspace.status,
      toStatus,
    });
    return { success: false, reason: 'wrong_state', currentStatus: workspace.status };
  }

  // Fetch the updated workspace
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
  });

  if (!workspace) {
    // Should not happen since we just updated it
    logger.error('Workspace disappeared after successful transition', { workspaceId });
    return { success: false, reason: 'not_found' };
  }

  logger.info('State transition succeeded', {
    workspaceId,
    toStatus,
    fromStatus: Array.isArray(fromStatus) ? fromStatus.join('|') : fromStatus,
  });

  return { success: true, workspace };
}

/**
 * Start provisioning a workspace (NEW -> PROVISIONING)
 */
export async function startProvisioning(workspaceId: string): Promise<TransitionResult> {
  logger.debug('Starting provisioning', { workspaceId });

  return await atomicTransition(workspaceId, 'NEW', 'PROVISIONING', {
    provisioningStartedAt: new Date(),
    errorMessage: null,
  });
}

/**
 * Complete provisioning successfully (PROVISIONING -> READY)
 */
export async function completeProvisioning(
  workspaceId: string,
  data?: { worktreePath?: string; branchName?: string }
): Promise<TransitionResult> {
  logger.debug('Completing provisioning', { workspaceId, ...data });

  return await atomicTransition(workspaceId, 'PROVISIONING', 'READY', {
    provisioningCompletedAt: new Date(),
    ...(data?.worktreePath !== undefined && { worktreePath: data.worktreePath }),
    ...(data?.branchName !== undefined && { branchName: data.branchName }),
  });
}

/**
 * Fail provisioning (PROVISIONING -> FAILED)
 */
export async function failProvisioning(
  workspaceId: string,
  errorMessage: string
): Promise<TransitionResult> {
  logger.warn('Failing provisioning', { workspaceId, errorMessage });

  return await atomicTransition(workspaceId, 'PROVISIONING', 'FAILED', {
    provisioningCompletedAt: new Date(),
    errorMessage,
  });
}

/**
 * Retry provisioning (FAILED -> PROVISIONING)
 * Only succeeds if retryCount < maxRetries
 */
export async function retryProvisioning(
  workspaceId: string,
  maxRetries = 3
): Promise<TransitionResult> {
  logger.debug('Attempting retry', { workspaceId, maxRetries });

  // Use atomic updateMany with retry count check
  const result = await prisma.workspace.updateMany({
    where: {
      id: workspaceId,
      status: 'FAILED',
      retryCount: { lt: maxRetries },
    },
    data: {
      status: 'PROVISIONING',
      retryCount: { increment: 1 },
      provisioningStartedAt: new Date(),
      errorMessage: null,
    },
  });

  if (result.count === 0) {
    // No rows updated - check why
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
    });

    if (!workspace) {
      logger.warn('Retry failed: workspace not found', { workspaceId });
      return { success: false, reason: 'not_found' };
    }

    if (workspace.status !== 'FAILED') {
      logger.warn('Retry failed: wrong state', {
        workspaceId,
        currentStatus: workspace.status,
      });
      return { success: false, reason: 'wrong_state', currentStatus: workspace.status };
    }

    if (workspace.retryCount >= maxRetries) {
      logger.warn('Retry failed: max retries exceeded', {
        workspaceId,
        retryCount: workspace.retryCount,
        maxRetries,
      });
      return { success: false, reason: 'max_retries_exceeded', currentStatus: workspace.status };
    }

    // Should not reach here, but fall back to invalid transition
    logger.warn('Retry failed: unexpected condition', { workspaceId, workspace });
    return { success: false, reason: 'invalid_transition', currentStatus: workspace.status };
  }

  // Fetch the updated workspace
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
  });

  if (!workspace) {
    logger.error('Workspace disappeared after successful retry transition', { workspaceId });
    return { success: false, reason: 'not_found' };
  }

  logger.info('Retry transition succeeded', {
    workspaceId,
    newRetryCount: workspace.retryCount,
  });

  return { success: true, workspace };
}

/**
 * Archive a workspace (any non-ARCHIVED state -> ARCHIVED)
 */
export async function archive(workspaceId: string): Promise<TransitionResult> {
  logger.debug('Archiving workspace', { workspaceId });

  // Archive is allowed from any state except ARCHIVED
  const validFromStates: WorkspaceStatus[] = ['NEW', 'PROVISIONING', 'READY', 'FAILED'];

  return await atomicTransition(workspaceId, validFromStates, 'ARCHIVED', {});
}

import type { RatchetDispatchOutcome } from '@prisma-gen/client';
import { SERVICE_THRESHOLDS } from '@/backend/services/constants';
import { KanbanColumn, PRState, RatchetState, WorkspaceStatus } from '@/shared/core';
import type { WorkspacePendingRequestType } from '@/shared/workspace-status-reason';

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

/**
 * Compute the Kanban column from next-action ownership.
 *
 * - WORKING: setup, a live agent session, or PR/Ratchet automation owns the next action
 * - WAITING: a human owns the next action or automated Ratchet retries are exhausted
 * - DONE: the pull request is merged or closed
 *
 * The column is derived on every read and never persisted, so every caller sees
 * the same answer for the same inputs. Archiving/archived workspaces return null
 * because they are excluded from the board rather than placed in a column.
 */
export function computeKanbanColumn(input: KanbanStateInput): KanbanColumn | null {
  const { lifecycle, prState, ratchetState } = input;
  const retriesExhausted =
    input.ratchetDispatchOutcome === 'DIED' &&
    input.ratchetDispatchRetryCount >= SERVICE_THRESHOLDS.ratchetDispatchMaxRetries;

  // Archiving/archived workspaces have no column; callers filter them out.
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

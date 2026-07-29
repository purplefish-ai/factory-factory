import { EventEmitter } from 'node:events';
import {
  type AutoIterationExecutionContext,
  workspaceAccessor,
} from '@/backend/services/workspace/resources/workspace.accessor';
import type { AutoIterationStatus, WorkspaceMode } from '@/shared/core';
import type { AutoIterationProgress } from '@/shared/schemas/auto-iteration.schema';

export const AUTO_ITERATION_STATUS_CHANGED = 'auto_iteration_status_changed' as const;

export interface AutoIterationStatusChangedEvent {
  workspaceId: string;
  mode: WorkspaceMode;
  status: AutoIterationStatus;
}

/**
 * The loop's persisted state, and the only place its transitions are announced.
 *
 * The event exists because `mode` and `autoIterationStatus` are derivation
 * inputs on the snapshot wire: the status reason reports `AUTO_ITERATING` from
 * them, which is what keeps a running loop out of the idle column between
 * iterations. Without an event the snapshot store learned about a transition
 * only from the reconciliation sweep, so for up to one sweep interval the live
 * stream re-derived every card from a stale status and could show a running loop
 * as waiting. Emitting beside the write rather than at the call sites means a
 * new caller cannot forget it.
 */
class WorkspaceAutoIterationService extends EventEmitter {
  getExecutionContext(workspaceId: string): Promise<AutoIterationExecutionContext | null> {
    return workspaceAccessor.findAutoIterationExecutionContext(workspaceId);
  }

  async setStatus(workspaceId: string, status: AutoIterationStatus): Promise<void> {
    const written = await workspaceAccessor.setAutoIterationStatus(workspaceId, status);
    this.emitStatusChanged(workspaceId, written.mode, written.status);
  }

  setProgress(workspaceId: string, progress: AutoIterationProgress) {
    return workspaceAccessor.setAutoIterationProgress(workspaceId, progress);
  }

  setSession(workspaceId: string, sessionId: string | null) {
    return workspaceAccessor.setAutoIterationSessionId(workspaceId, sessionId);
  }

  async finishSessionIfMatching(
    workspaceId: string,
    sessionId: string,
    status: AutoIterationStatus
  ): Promise<boolean> {
    const result = await workspaceAccessor.finishAutoIterationIfSessionMatches(
      workspaceId,
      sessionId,
      status
    );
    // A compare-and-swap that matched nothing settled no loop, so there is no
    // transition to announce.
    if (result.settled && result.mode !== null) {
      this.emitStatusChanged(workspaceId, result.mode, status);
    }
    return result.settled;
  }

  clearSessionIfMatching(workspaceId: string, sessionId: string): Promise<boolean> {
    return workspaceAccessor.clearAutoIterationSessionIfMatches(workspaceId, sessionId);
  }

  recoverStaleStatuses() {
    return workspaceAccessor.resetStaleAutoIterationStatuses();
  }

  private emitStatusChanged(
    workspaceId: string,
    mode: WorkspaceMode,
    status: AutoIterationStatus
  ): void {
    this.emit(AUTO_ITERATION_STATUS_CHANGED, {
      workspaceId,
      mode,
      status,
    } satisfies AutoIterationStatusChangedEvent);
  }
}

export const workspaceAutoIterationService = new WorkspaceAutoIterationService();

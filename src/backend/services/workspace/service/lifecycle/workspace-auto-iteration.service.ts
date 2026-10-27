import { EventEmitter } from 'node:events';
import type { WorkspaceAutoIterationWriteResult } from '@/backend/services/workspace/resources/workspace-auto-iteration.accessor';
import {
  type AutoIterationExecutionContext,
  workspaceAccessor,
} from '@/backend/services/workspace/resources/workspace.accessor';
import type { AutoIterationStatus, WorkspaceMode } from '@/shared/core';
import type { AutoIterationProgress } from '@/shared/schemas/auto-iteration.schema';
import {
  projectAutoIterationSummary,
  type WorkspaceAutoIterationSummary,
} from '@/shared/workspace-summary';

export const AUTO_ITERATION_SUMMARY_CHANGED = 'auto_iteration_summary_changed' as const;
export interface AutoIterationSummaryChangedEvent {
  workspaceId: string;
  mode: WorkspaceMode;
  autoIterationStatus: AutoIterationStatus | null;
  autoIteration: WorkspaceAutoIterationSummary | null;
}

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
  private publishAcceptedSummary(
    workspaceId: string,
    written: WorkspaceAutoIterationWriteResult
  ): void {
    this.emit(AUTO_ITERATION_SUMMARY_CHANGED, {
      workspaceId,
      mode: written.mode,
      autoIterationStatus: written.status,
      autoIteration: projectAutoIterationSummary({
        mode: written.mode,
        autoIterationStatus: written.status,
        autoIterationConfig: written.config,
        autoIterationProgress: written.progress,
      }),
    } satisfies AutoIterationSummaryChangedEvent);
  }

  getExecutionContext(workspaceId: string): Promise<AutoIterationExecutionContext | null> {
    return workspaceAccessor.findAutoIterationExecutionContext(workspaceId);
  }

  async setStatus(workspaceId: string, status: AutoIterationStatus): Promise<void> {
    const written = await workspaceAccessor.setAutoIterationStatus(workspaceId, status);
    if (written.status !== null) {
      this.emitStatusChanged(workspaceId, written.mode, written.status);
    }
    this.publishAcceptedSummary(workspaceId, written);
  }

  async setProgress(workspaceId: string, progress: AutoIterationProgress) {
    const written = await workspaceAccessor.setAutoIterationProgress(workspaceId, progress);
    this.publishAcceptedSummary(workspaceId, written);
  }

  setSession(workspaceId: string, sessionId: string | null) {
    return workspaceAccessor.setAutoIterationSessionId(workspaceId, sessionId);
  }

  async finishSessionIfMatching(
    workspaceId: string,
    sessionId: string,
    status: AutoIterationStatus
  ): Promise<boolean> {
    const written = await workspaceAccessor.finishAutoIterationIfSessionMatches(
      workspaceId,
      sessionId,
      status
    );
    // A no-row compare-and-swap settled no loop and has nothing to publish.
    if (!written) {
      return false;
    }
    if (written.status !== null) {
      this.emitStatusChanged(workspaceId, written.mode, written.status);
    }
    this.publishAcceptedSummary(workspaceId, written);
    return true;
  }

  clearSessionIfMatching(workspaceId: string, sessionId: string): Promise<boolean> {
    return workspaceAccessor.clearAutoIterationSessionIfMatches(workspaceId, sessionId);
  }

  async recoverStaleStatuses() {
    const recovered = await workspaceAccessor.resetStaleAutoIterationStatuses();
    // Recovery runs behind the startup command gate. Retain the existing batch
    // contract, and publish exactly the rows each guarded write accepted.
    for (const { id, written } of recovered) {
      this.publishAcceptedSummary(id, written);
    }
    return recovered.map(({ id }) => ({ id }));
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

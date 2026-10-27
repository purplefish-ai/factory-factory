import { EventEmitter } from 'node:events';
import { createLogger } from '@/backend/services/logger.service';
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

const logger = createLogger('workspace-auto-iteration');
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
  // These tokens fence asynchronous publication reads only. Session CAS and
  // loop ownership remain the persistence/workflow authority.
  private readonly pendingSummaryReads = new Map<string, symbol>();

  private async publishAcceptedSummary(workspaceId: string): Promise<void> {
    const token = Symbol();
    this.pendingSummaryReads.set(workspaceId, token);
    try {
      const persisted = await workspaceAccessor.findAutoIterationSnapshot(workspaceId);
      if (!persisted || this.pendingSummaryReads.get(workspaceId) !== token) {
        return;
      }
      this.emit(AUTO_ITERATION_SUMMARY_CHANGED, {
        workspaceId,
        mode: persisted.mode,
        autoIterationStatus: persisted.autoIterationStatus,
        autoIteration: projectAutoIterationSummary(persisted),
      } satisfies AutoIterationSummaryChangedEvent);
    } catch (error) {
      // Persistence already succeeded. Reconciliation repairs a failed read;
      // do not report that accepted mutation as a failed write to the caller.
      logger.warn('Failed to read accepted loop summary', { workspaceId, error });
    } finally {
      if (this.pendingSummaryReads.get(workspaceId) === token) {
        this.pendingSummaryReads.delete(workspaceId);
      }
    }
  }

  getExecutionContext(workspaceId: string): Promise<AutoIterationExecutionContext | null> {
    return workspaceAccessor.findAutoIterationExecutionContext(workspaceId);
  }

  async setStatus(workspaceId: string, status: AutoIterationStatus): Promise<void> {
    const written = await workspaceAccessor.setAutoIterationStatus(workspaceId, status);
    this.emitStatusChanged(workspaceId, written.mode, written.status);
    await this.publishAcceptedSummary(workspaceId);
  }

  async setProgress(workspaceId: string, progress: AutoIterationProgress) {
    await workspaceAccessor.setAutoIterationProgress(workspaceId, progress);
    await this.publishAcceptedSummary(workspaceId);
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
      await this.publishAcceptedSummary(workspaceId);
    }
    return result.settled;
  }

  clearSessionIfMatching(workspaceId: string, sessionId: string): Promise<boolean> {
    return workspaceAccessor.clearAutoIterationSessionIfMatches(workspaceId, sessionId);
  }

  async recoverStaleStatuses() {
    const recovered = await workspaceAccessor.resetStaleAutoIterationStatuses();
    await Promise.all(recovered.map(({ id }) => this.publishAcceptedSummary(id)));
    return recovered;
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

import { EventEmitter } from 'node:events';
import pLimit from 'p-limit';
import { SERVICE_INTERVAL_MS, SERVICE_TIMEOUT_MS } from '@/backend/services/constants';
import { jobRunner } from '@/backend/services/job-runner.service';
import { createLogger } from '@/backend/services/logger.service';
import { RateLimitBackoff } from '@/backend/services/rate-limit-backoff';
import {
  workspacePRMonitoringService,
  workspacePrSnapshotService,
} from '@/backend/services/workspace';
import { type CIStatus, deriveRatchetState, RatchetState } from '@/shared/core';
import type { PRTarget, PRDeliveryMode } from '@/shared/pr-monitoring';

const logger = createLogger('ratchet');
const POLL_JOB = 'pr-event-poll';
export const RATCHET_STATE_CHANGED = 'ratchet_state_changed' as const;
export const RATCHET_TOGGLED = 'ratchet_toggled' as const;
export const RATCHET_DISPATCH_CHANGED = 'ratchet_dispatch_changed' as const;
export interface RatchetDispatchChangedEvent {
  workspaceId: string;
}
export interface RatchetStateChangedEvent {
  workspaceId: string;
  prId?: string;
  fromState: RatchetState;
  toState: RatchetState;
  prCiStatus?: CIStatus;
}
export interface RatchetToggledEvent {
  workspaceId: string;
  enabled: boolean;
  ratchetState: RatchetState;
}
export type RatchetAction =
  | { type: 'WAITING'; reason: string }
  | { type: 'EVENTS_QUEUED' }
  | { type: 'ERROR'; error: string };
export interface WorkspaceRatchetResult {
  workspaceId: string;
  previousState: RatchetState;
  newState: RatchetState;
  action: RatchetAction;
}
export interface RatchetCheckResult {
  checked: number;
  stateChanges: number;
  actionsTriggered: number;
  results: WorkspaceRatchetResult[];
}
interface MonitoringBridge {
  retireLegacy?(): Promise<unknown>;
  observe(target: PRTarget, signal?: AbortSignal): Promise<boolean>;
  wake(workspaceId: string): Promise<void>;
  setMonitoring(input: {
    workspaceId: string;
    enabled: boolean;
    recipientSessionId?: string | null;
    deliveryMode?: PRDeliveryMode;
    resume?: boolean;
    expectedBindingRevision: number;
  }): Promise<
    | { status: 'updated'; bindingRevision: number }
    | {
        status: 'recipient_required';
        bindingRevision: number;
        candidates: { id: string; name: string | null; provider: string }[];
      }
  >;
}
function aggregateState(
  rows: {
    state: string;
    ciStatus: CIStatus;
    hasMergeConflict: boolean;
    reviewState: string | null;
  }[]
): RatchetState {
  const states = rows.map((pr) =>
    deriveRatchetState({
      ratchetEnabled: true,
      prState: pr.state as Parameters<typeof deriveRatchetState>[0]['prState'],
      prCiStatus: pr.ciStatus,
      prHasMergeConflict: pr.hasMergeConflict,
      prReviewState: pr.reviewState,
    })
  );
  if (states.length && states.every((s) => s === RatchetState.MERGED)) {
    return RatchetState.MERGED;
  }
  return (
    [
      RatchetState.MERGE_CONFLICT,
      RatchetState.CI_FAILED,
      RatchetState.REVIEW_PENDING,
      RatchetState.CI_RUNNING,
      RatchetState.READY,
    ].find((s) => states.includes(s)) ?? RatchetState.IDLE
  );
}
export class RatchetService extends EventEmitter {
  private bridge: MonitoringBridge | null = null;
  private stopped = false;
  private backoff = new RateLimitBackoff();
  private limit = pLimit(3);
  private checking = new Map<string, Promise<WorkspaceRatchetResult>>();
  private controllers = new Set<AbortController>();
  constructor() {
    super();
    jobRunner.register({
      name: POLL_JOB,
      intervalMs: SERVICE_INTERVAL_MS.ratchetPoll,
      runImmediately: true,
      run: async (signal) => {
        this.backoff.beginCycle();
        await this.checkAllWorkspaces(signal);
        this.backoff.resetIfCleanCycle(logger, 'PR monitoring');
      },
      computeDelay: (base) => this.backoff.computeDelay(base),
    });
  }
  configure(bridge: MonitoringBridge) {
    this.bridge = bridge;
  }
  async start() {
    this.stopped = false;
    await this.bridge?.retireLegacy?.();
    if (!this.stopped) {
      jobRunner.start(POLL_JOB);
    }
  }
  async stop() {
    this.stopped = true;
    for (const controller of this.controllers) {
      controller.abort();
    }
    await jobRunner.stop(POLL_JOB);
  }
  async checkAllWorkspaces(signal?: AbortSignal): Promise<RatchetCheckResult> {
    if (this.stopped || signal?.aborted) {
      return { checked: 0, stateChanges: 0, actionsTriggered: 0, results: [] };
    }
    const workspaces = await workspacePRMonitoringService.listEnabled();
    if (this.stopped || signal?.aborted) {
      return { checked: 0, stateChanges: 0, actionsTriggered: 0, results: [] };
    }
    const results = await Promise.all(
      workspaces.map((config) => this.limit(() => this.check(config, signal)))
    );
    return {
      checked: results.length,
      stateChanges: results.filter((r) => r.previousState !== r.newState).length,
      actionsTriggered: results.filter((r) => r.action.type === 'EVENTS_QUEUED').length,
      results,
    };
  }
  async checkWorkspaceById(workspaceId: string, _options?: { bypassPrFetchCooldown?: boolean }) {
    if (this.stopped) {
      return null;
    }
    const config = (await workspacePRMonitoringService.listEnabled()).find(
      (c) => c.workspaceId === workspaceId
    );
    return !this.stopped && config ? await this.check(config) : null;
  }
  private check(
    config: Awaited<ReturnType<typeof workspacePRMonitoringService.listEnabled>>[number],
    parentSignal?: AbortSignal
  ): Promise<WorkspaceRatchetResult> {
    const previousState = aggregateState(config.workspace.prs);
    if (this.stopped || parentSignal?.aborted) {
      return Promise.resolve({
        workspaceId: config.workspaceId,
        previousState,
        newState: previousState,
        action: { type: 'WAITING', reason: 'PR monitoring stopped' },
      });
    }
    const existing = this.checking.get(config.workspaceId);
    if (existing !== undefined) {
      return existing;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(SERVICE_TIMEOUT_MS.ratchetWorkspaceCheck),
      ...(parentSignal ? [parentSignal] : []),
    ]);
    const bridge = this.bridge;
    if (!bridge) {
      return Promise.reject(new Error('PR monitoring bridge is not configured'));
    }
    const run = (async () => {
      try {
        await this.observeAssociations(config, bridge, signal);
        signal.throwIfAborted();
        await workspacePRMonitoringService.markChecked(config.workspaceId);
        signal.throwIfAborted();
        const queued = await workspacePRMonitoringService.listPending(config.workspaceId);
        signal.throwIfAborted();
        await bridge.wake(config.workspaceId);
        signal.throwIfAborted();
        this.emit(RATCHET_DISPATCH_CHANGED, { workspaceId: config.workspaceId });
        signal.throwIfAborted();
        const newState = aggregateState(await workspacePrSnapshotService.list(config.workspaceId));
        signal.throwIfAborted();
        this.emitStateChange(config.workspaceId, previousState, newState);
        return {
          workspaceId: config.workspaceId,
          previousState,
          newState,
          action: queued.length
            ? { type: 'EVENTS_QUEUED' as const }
            : { type: 'WAITING' as const, reason: 'No actionable PR changes' },
        };
      } catch (error) {
        if (!signal.aborted) {
          this.backoff.handleError(
            error,
            logger,
            'PR monitoring',
            { workspaceId: config.workspaceId, prUrl: config.workspace.prs[0]?.url ?? '' },
            SERVICE_INTERVAL_MS.ratchetPoll
          );
        }
        return {
          workspaceId: config.workspaceId,
          previousState,
          newState: previousState,
          action: {
            type: 'ERROR' as const,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      } finally {
        this.controllers.delete(controller);
        this.checking.delete(config.workspaceId);
      }
    })();
    this.checking.set(config.workspaceId, run);
    return run;
  }
  private async observeAssociations(
    config: Awaited<ReturnType<typeof workspacePRMonitoringService.listEnabled>>[number],
    bridge: MonitoringBridge,
    signal: AbortSignal
  ) {
    for (const pr of config.workspace.prs) {
      signal.throwIfAborted();
      try {
        await bridge.observe({ workspaceId: config.workspaceId, prId: pr.id }, signal);
      } catch (error) {
        signal.throwIfAborted();
        const rateLimited = this.backoff.handleError(
          error,
          logger,
          'PR monitoring',
          { workspaceId: config.workspaceId, prUrl: pr.url },
          SERVICE_INTERVAL_MS.ratchetPoll
        );
        if (rateLimited) {
          break;
        }
      }
    }
  }
  private emitStateChange(
    workspaceId: string,
    previousState: RatchetState,
    newState: RatchetState
  ) {
    if (newState !== previousState) {
      this.emit(RATCHET_STATE_CHANGED, {
        workspaceId,
        fromState: previousState,
        toState: newState,
      });
    }
  }
  async setWorkspaceRatcheting(
    workspaceId: string,
    enabled: boolean,
    options?: {
      recipientSessionId?: string | null;
      expectedBindingRevision?: number;
      deliveryMode?: PRDeliveryMode;
      resume?: boolean;
    }
  ) {
    if (!this.bridge) {
      throw new Error('PR monitoring bridge is not configured');
    }
    const config = await workspacePRMonitoringService.get(workspaceId);
    const result = await this.bridge.setMonitoring({
      workspaceId,
      enabled,
      recipientSessionId: options?.recipientSessionId,
      deliveryMode: options?.deliveryMode,
      resume: options?.resume,
      expectedBindingRevision: options?.expectedBindingRevision ?? config?.bindingRevision ?? 0,
    });
    if (result.status === 'updated') {
      if (enabled !== (config?.enabled ?? false)) {
        this.emit(RATCHET_TOGGLED, { workspaceId, enabled, ratchetState: RatchetState.IDLE });
      } else {
        this.emit(RATCHET_DISPATCH_CHANGED, { workspaceId });
      }
    }
    return result;
  }
}
export const ratchetService = new RatchetService();

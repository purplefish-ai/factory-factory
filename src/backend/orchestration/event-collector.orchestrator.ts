/**
 * Event Collector Orchestrator
 *
 * Subscribes to all domain event sources and translates domain events into
 * snapshot store mutations through a per-workspace coalescing buffer.
 *
 * The coalescing strategy uses a trailing-edge debounce: when events arrive
 * for a workspace, fields are accumulated and the timer is reset. After the
 * window expires (default 150ms), accumulated fields are flushed in a single
 * store.upsert() call. This prevents expensive derived-state recomputation
 * and downstream WebSocket pushes for intermediate states.
 *
 * Import rules (EVNT-07 + circular dep avoidance):
 * - Event constants and dependency types from domain barrels
 * - Runtime event sources and stores supplied by the composition root
 * - NOT re-exported from orchestration/index.ts (circular dep risk)
 */

import {
  buildWorkspaceSessionSummaries,
  hasWorkingSessionSummary,
} from '@/backend/lib/session-summaries';
import { SERVICE_LIMITS } from '@/backend/services/constants';
import {
  PR_DISPATCH_INVALIDATED,
  PR_SNAPSHOT_UPDATED,
  type PRDispatchInvalidatedEvent,
  type PRSnapshotUpdatedEvent,
  type prFetchRegistry,
  type prSnapshotService,
} from '@/backend/services/github';
import type { linearStateSyncService } from '@/backend/services/linear';
import type { createLogger } from '@/backend/services/logger.service';
import {
  RATCHET_DISPATCH_CHANGED,
  RATCHET_STATE_CHANGED,
  RATCHET_TOGGLED,
  type RatchetDispatchChangedEvent,
  type RatchetStateChangedEvent,
  type RatchetToggledEvent,
  type ratchetService,
} from '@/backend/services/ratchet';
import {
  RUN_SCRIPT_STATUS_CHANGED,
  type RunScriptStatusChangedEvent,
  type runScriptStateMachine,
} from '@/backend/services/run-script';
import type {
  chatEventForwarderService,
  sessionDataService,
  sessionDomainService,
  sessionService,
} from '@/backend/services/session';
import type { terminalService } from '@/backend/services/terminal';
import type { SnapshotUpdateInput } from '@/backend/services/workspace';
import {
  type computePendingRequestType,
  type kanbanStateService,
  WORKSPACE_STATE_CHANGED,
  type WorkspaceStateChangedEvent,
  type workspaceAccessor,
  type workspaceActivityService,
  type workspaceSnapshotStore,
  type workspaceStateMachine,
} from '@/backend/services/workspace';
import { type CIStatus, type PRState, WorkspaceStatus } from '@/shared/core';
import type { getWorkspaceLinearContext } from './linear-config.helper';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoreInterface {
  upsert(
    workspaceId: string,
    update: SnapshotUpdateInput,
    source: string,
    timestamp?: number
  ): void;
  getByWorkspaceId(workspaceId: string):
    | {
        projectId: string;
        prNumber?: number | null;
        prUrl?: string | null;
        prState?: PRState;
      }
    | undefined;
  remove(workspaceId: string): boolean;
}

interface PendingUpdate {
  fields: SnapshotUpdateInput;
  sources: Set<string>;
  timer: NodeJS.Timeout | null;
}

interface EnqueueOptions {
  immediate?: boolean;
}

interface PendingRequestChangedEvent {
  sessionId: string;
  requestId: string;
  hasPending: boolean;
}

// ---------------------------------------------------------------------------
// EventCoalescer
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_MS = 150;
const IDLE_PR_REFRESH_COOLDOWN_MS = 30_000;
const PROJECTION_RETRY_BASE_MS = 1000;
const MAX_PROJECTION_RETRY_BACKOFF_EXPONENT = 6;
let lastCoalescerTimestamp = 0;

function nextCoalescerTimestamp(): number {
  const timestamp = Math.max(Date.now(), lastCoalescerTimestamp + 1);
  lastCoalescerTimestamp = timestamp;
  return timestamp;
}

type Logger = Pick<ReturnType<typeof createLogger>, 'debug' | 'error' | 'info' | 'warn'>;

export type EventCollectorDependencies = {
  chatEventForwarderService: typeof chatEventForwarderService;
  computePendingRequestType: typeof computePendingRequestType;
  createLogger(component: string): Logger;
  getWorkspaceLinearContext: typeof getWorkspaceLinearContext;
  kanbanStateService: typeof kanbanStateService;
  linearStateSyncService: typeof linearStateSyncService;
  prFetchRegistry: typeof prFetchRegistry;
  prSnapshotService: typeof prSnapshotService;
  ratchetService: typeof ratchetService;
  runScriptStateMachine: typeof runScriptStateMachine;
  sessionDataService: typeof sessionDataService;
  sessionDomainService: typeof sessionDomainService;
  sessionService: typeof sessionService;
  terminalService: typeof terminalService;
  workspaceActivityService: typeof workspaceActivityService;
  workspaceAccessor: typeof workspaceAccessor;
  workspaceSnapshotStore: typeof workspaceSnapshotStore;
  workspaceStateMachine: typeof workspaceStateMachine;
};

function refreshCachedKanbanColumn(state: EventCollectorState, workspaceId: string): void {
  void state.dependencies.kanbanStateService
    .updateCachedKanbanColumn(workspaceId)
    .catch((error) => {
      state.logger.warn('Failed to refresh cached kanban column after Ratchet change', {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

async function projectAuthoritativeRatchetState(
  state: EventCollectorState,
  coalescer: EventCoalescer,
  workspaceId: string,
  isActive: () => boolean
): Promise<boolean> {
  try {
    const workspace = await state.dependencies.workspaceAccessor.findRawById(workspaceId);
    if (
      !(workspace && isActive()) ||
      workspace.status === WorkspaceStatus.ARCHIVING ||
      workspace.status === WorkspaceStatus.ARCHIVED
    ) {
      return true;
    }
    coalescer.enqueue(
      workspaceId,
      {
        ratchetEnabled: workspace.ratchetEnabled,
        ratchetState: workspace.ratchetState,
        ratchetDispatchOutcome: workspace.ratchetDispatchOutcome,
        ratchetDispatchRetryCount: workspace.ratchetDispatchRetryCount,
      },
      'projection:ratchet_authoritative',
      { immediate: true }
    );
    return true;
  } catch (error) {
    state.logger.warn('Failed to refresh authoritative Ratchet snapshot projection', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function getNewerProjectionRevision(refresh: { revision: number }, target: number): number | null {
  return refresh.revision > target ? refresh.revision : null;
}

async function runRatchetProjectionRefresh(params: {
  state: EventCollectorState;
  coalescer: EventCoalescer;
  workspaceId: string;
  refresh: { revision: number };
  refreshes: Map<string, { revision: number }>;
  isActive: () => boolean;
  waitForRetry: (attempt: number) => Promise<void>;
}): Promise<void> {
  const { state, coalescer, workspaceId, refresh, refreshes, isActive, waitForRetry } = params;
  let targetRevision = refresh.revision;
  let failedAttempts = 0;
  try {
    while (isActive()) {
      const succeeded = await projectAuthoritativeRatchetState(
        state,
        coalescer,
        workspaceId,
        isActive
      );
      const newerRevision = getNewerProjectionRevision(refresh, targetRevision);
      if (succeeded) {
        if (newerRevision === null) {
          break;
        }
        targetRevision = newerRevision;
        failedAttempts = 0;
        continue;
      }
      if (newerRevision !== null) {
        targetRevision = newerRevision;
        failedAttempts = 0;
        continue;
      }
      failedAttempts += 1;
      if (!isActive()) {
        break;
      }
      await waitForRetry(Math.min(failedAttempts - 1, MAX_PROJECTION_RETRY_BACKOFF_EXPONENT));
    }
  } finally {
    if (refreshes.get(workspaceId) === refresh) {
      refreshes.delete(workspaceId);
    }
  }
}

function shouldRefreshRatchetForPrSwitch(
  previousSnapshot: ReturnType<StoreInterface['getByWorkspaceId']>,
  event: PRSnapshotUpdatedEvent
): boolean {
  if (!previousSnapshot) {
    return false;
  }

  const hadPreviouslyLinkedPr =
    previousSnapshot.prNumber !== null || previousSnapshot.prUrl !== null;
  if (!hadPreviouslyLinkedPr) {
    return false;
  }

  const prNumberChanged =
    previousSnapshot.prNumber !== null && previousSnapshot.prNumber !== event.prNumber;
  const prUrlChanged =
    previousSnapshot.prUrl !== null &&
    event.prUrl !== undefined &&
    event.prUrl !== null &&
    previousSnapshot.prUrl !== event.prUrl;
  // The ratchet poll query excludes prState CLOSED, so a reopened PR needs an
  // immediate check here to resume ratcheting as soon as the reopen is synced.
  // A reopened PR can land on any non-CLOSED state (OPEN/DRAFT/APPROVED/...).
  const prReopened = previousSnapshot.prState === 'CLOSED' && event.prState !== 'CLOSED';

  return prNumberChanged || prUrlChanged || prReopened;
}

/**
 * Per-workspace coalescing buffer that accumulates SnapshotUpdateInput fields
 * and flushes them in a single store.upsert() after a debounce window.
 *
 * Exported for direct unit testing.
 */
export class EventCoalescer {
  private pending = new Map<string, PendingUpdate>();

  constructor(
    private store: StoreInterface,
    private windowMs = DEFAULT_WINDOW_MS,
    private logger?: Pick<Logger, 'debug'>
  ) {}

  /**
   * Accumulate fields for a workspace. Resets the debounce timer on each call.
   */
  enqueue(
    workspaceId: string,
    fields: SnapshotUpdateInput,
    source: string,
    options?: EnqueueOptions
  ): void {
    let pending = this.pending.get(workspaceId);

    if (pending) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      Object.assign(pending.fields, fields);
      pending.sources.add(source);
    } else {
      pending = {
        fields: { ...fields },
        sources: new Set([source]),
        timer: null,
      };
      this.pending.set(workspaceId, pending);
    }

    if (options?.immediate) {
      this.flush(workspaceId);
      return;
    }

    pending.timer = setTimeout(() => this.flush(workspaceId), this.windowMs);
  }

  /**
   * Flush a single workspace's pending update to the store.
   */
  private flush(workspaceId: string): void {
    const pending = this.pending.get(workspaceId);
    if (!pending) {
      return;
    }

    this.pending.delete(workspaceId);

    // Guard: if workspace not in store AND pending fields lack projectId,
    // skip -- reconciliation (Phase 14) will seed it
    const existing = this.store.getByWorkspaceId(workspaceId);
    if (!(existing || pending.fields.projectId)) {
      this.logger?.debug('Skipping upsert for unknown workspace (awaiting reconciliation)', {
        workspaceId,
        sources: [...pending.sources],
      });
      return;
    }

    const source = [...pending.sources].join('+');
    this.store.upsert(workspaceId, pending.fields, source, nextCoalescerTimestamp());
  }

  /**
   * Flush all pending updates immediately. Used for server shutdown.
   */
  flushAll(): void {
    for (const [workspaceId, pending] of this.pending) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }

      const existing = this.store.getByWorkspaceId(workspaceId);
      if (!(existing || pending.fields.projectId)) {
        this.logger?.debug('Skipping upsert for unknown workspace during flushAll', {
          workspaceId,
          sources: [...pending.sources],
        });
        continue;
      }

      const source = [...pending.sources].join('+');
      this.store.upsert(workspaceId, pending.fields, source, nextCoalescerTimestamp());
    }
    this.pending.clear();
  }

  removeWorkspace(workspaceId: string): void {
    const pending = this.pending.get(workspaceId);
    if (pending?.timer) {
      clearTimeout(pending.timer);
    }
    this.pending.delete(workspaceId);
    this.store.remove(workspaceId);
  }

  /**
   * Number of workspaces with pending updates (for testing).
   */
  get pendingCount(): number {
    return this.pending.size;
  }
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

class EventCollectorState {
  readonly logger: Logger;
  activeCoalescer: EventCoalescer | null = null;
  lastIdlePrRefreshByWorkspace = new Map<string, number>();
  teardownListeners: Array<() => void> = [];
  stopRatchetProjection: (() => void) | null = null;

  constructor(readonly dependencies: Readonly<EventCollectorDependencies>) {
    this.logger = dependencies.createLogger('event-collector');
  }
}

function removeWorkspaceWithState(state: EventCollectorState, workspaceId: string): void {
  if (state.activeCoalescer) {
    state.activeCoalescer.removeWorkspace(workspaceId);
  } else {
    state.dependencies.workspaceSnapshotStore.remove(workspaceId);
  }
  state.lastIdlePrRefreshByWorkspace.delete(workspaceId);
  state.dependencies.workspaceActivityService.clearWorkspace(workspaceId);
  state.dependencies.prFetchRegistry.removeWorkspace(workspaceId);
}

async function refreshWorkspaceSessionSummaries(
  state: EventCollectorState,
  coalescer: EventCoalescer,
  workspaceId: string,
  source: string,
  options?: { includeWorking?: boolean }
): Promise<void> {
  try {
    if (state.activeCoalescer !== coalescer) {
      return;
    }
    const sessions =
      await state.dependencies.sessionDataService.findAgentSessionsByWorkspaceId(workspaceId);
    if (state.activeCoalescer !== coalescer) {
      return;
    }
    const sessionSummaries = buildWorkspaceSessionSummaries(sessions, (sessionId) =>
      state.dependencies.sessionService.getRuntimeSnapshot(sessionId)
    );
    coalescer.enqueue(
      workspaceId,
      {
        sessionSummaries,
        ...(sessionSummaries.length > 0 ? { hasHadSessions: true } : {}),
        ...(options?.includeWorking
          ? { isWorking: hasWorkingSessionSummary(sessionSummaries) }
          : {}),
      },
      source
    );
  } catch (error) {
    state.logger.warn('Failed to refresh workspace session summaries', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function refreshWorkspacePendingRequestType(
  state: EventCollectorState,
  coalescer: EventCoalescer,
  sessionId: string,
  source: string
): Promise<void> {
  try {
    if (state.activeCoalescer !== coalescer) {
      return;
    }
    const session = await state.dependencies.sessionDataService.findAgentSessionById(sessionId);
    if (!session || state.activeCoalescer !== coalescer) {
      return;
    }

    const sessions = await state.dependencies.sessionDataService.findAgentSessionsByWorkspaceId(
      session.workspaceId
    );
    if (state.activeCoalescer !== coalescer) {
      return;
    }

    const pendingRequestType = state.dependencies.computePendingRequestType(
      sessions.map((s) => s.id),
      state.dependencies.chatEventForwarderService.getAllPendingRequests()
    );
    coalescer.enqueue(session.workspaceId, { pendingRequestType }, source);
  } catch (error) {
    state.logger.warn('Failed to refresh workspace pending request type', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function refreshWorkspaceSessionSummariesForSession(
  state: EventCollectorState,
  coalescer: EventCoalescer,
  sessionId: string,
  source: string
): Promise<void> {
  try {
    if (state.activeCoalescer !== coalescer) {
      return;
    }
    const session = await state.dependencies.sessionDataService.findAgentSessionById(sessionId);
    if (!session || state.activeCoalescer !== coalescer) {
      return;
    }
    await refreshWorkspaceSessionSummaries(state, coalescer, session.workspaceId, source, {
      includeWorking: true,
    });
  } catch (error) {
    state.logger.warn('Failed to refresh workspace session summaries from runtime change', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Build the snapshot update for a workspace state change. Beyond the status,
 * forward the snapshot-relevant fields co-updated in the transition (e.g.
 * branchName on READY) from the re-read row, so they don't wait for the next
 * reconciliation pass. Carrying projectId also lets the coalescer seed
 * workspaces the store doesn't know yet; the state machine suppresses
 * superseded events, so this cannot re-seed an entry a newer ARCHIVED event
 * removed. hasHadSessions is deliberately excluded: the session-activity path
 * sets it optimistically in the store and a lagging DB row must not
 * downgrade it.
 */
function buildWorkspaceStateChangeFields(event: WorkspaceStateChangedEvent): SnapshotUpdateInput {
  return {
    status: event.toStatus,
    projectId: event.workspace.projectId,
    name: event.workspace.name,
    branchName: event.workspace.branchName,
    createdAt: event.workspace.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Linear state sync on PR merge
// ---------------------------------------------------------------------------

async function handleLinearIssueCompletedOnMerge(
  state: EventCollectorState,
  workspaceId: string
): Promise<void> {
  try {
    const ctx = await state.dependencies.getWorkspaceLinearContext(workspaceId);
    if (!ctx) {
      return;
    }

    await state.dependencies.linearStateSyncService.markIssueCompleted(
      ctx.apiKey,
      ctx.linearIssueId
    );
    state.logger.info('Marked Linear issue as completed on PR merge', {
      workspaceId,
      linearIssueId: ctx.linearIssueId,
    });
  } catch (error) {
    state.logger.warn('Failed to mark Linear issue as completed on PR merge', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Event collector lifecycle
// ---------------------------------------------------------------------------

/**
 * Subscribe to all domain event sources and route events through the
 * coalescing buffer to the snapshot store.
 *
 * The dependencies are fixed when the graph is composed. Repeated starts are
 * idempotent, and stop detaches every listener registered here.
 */
function startEventCollectorWithState(state: EventCollectorState): void {
  if (state.activeCoalescer) {
    return;
  }

  const dependencies = state.dependencies;
  const coalescer = new EventCoalescer(
    dependencies.workspaceSnapshotStore,
    DEFAULT_WINDOW_MS,
    state.logger
  );
  state.activeCoalescer = coalescer;
  const ratchetProjectionRefreshes = new Map<string, { revision: number }>();
  const archivedProjectionWorkspaceIds = new Set<string>();
  let projectionActive = true;
  const projectionRetryWaiters = new Set<{
    timer: NodeJS.Timeout;
    resolve: () => void;
  }>();
  state.stopRatchetProjection = () => {
    projectionActive = false;
    for (const waiter of projectionRetryWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    projectionRetryWaiters.clear();
    ratchetProjectionRefreshes.clear();
    archivedProjectionWorkspaceIds.clear();
  };

  const waitForProjectionRetry = (attempt: number): Promise<void> =>
    new Promise((resolve) => {
      if (!projectionActive || state.activeCoalescer !== coalescer) {
        resolve();
        return;
      }
      const waiter = {
        timer: setTimeout(
          () => {
            projectionRetryWaiters.delete(waiter);
            resolve();
          },
          PROJECTION_RETRY_BASE_MS * 2 ** attempt
        ),
        resolve,
      };
      projectionRetryWaiters.add(waiter);
    });

  const requestAuthoritativeRatchetProjection = (workspaceId: string): void => {
    if (archivedProjectionWorkspaceIds.has(workspaceId)) {
      return;
    }
    const existing = ratchetProjectionRefreshes.get(workspaceId);
    if (existing) {
      existing.revision += 1;
      return;
    }

    const refresh = { revision: 1 };
    ratchetProjectionRefreshes.set(workspaceId, refresh);
    void runRatchetProjectionRefresh({
      state,
      coalescer,
      workspaceId,
      refresh,
      refreshes: ratchetProjectionRefreshes,
      isActive: () =>
        projectionActive &&
        state.activeCoalescer === coalescer &&
        !archivedProjectionWorkspaceIds.has(workspaceId),
      waitForRetry: waitForProjectionRetry,
    });
  };
  state.lastIdlePrRefreshByWorkspace.clear();

  const refreshPrSnapshotOnIdle = (workspaceId: string): void => {
    const now = Date.now();
    const lastRefresh = state.lastIdlePrRefreshByWorkspace.get(workspaceId) ?? 0;
    if (now - lastRefresh < IDLE_PR_REFRESH_COOLDOWN_MS) {
      return;
    }
    if (
      !state.lastIdlePrRefreshByWorkspace.has(workspaceId) &&
      state.lastIdlePrRefreshByWorkspace.size >= SERVICE_LIMITS.workspaceScopedCacheMaxEntries
    ) {
      const oldestWorkspaceId = state.lastIdlePrRefreshByWorkspace.keys().next().value;
      if (oldestWorkspaceId !== undefined) {
        state.lastIdlePrRefreshByWorkspace.delete(oldestWorkspaceId);
      }
    }
    state.lastIdlePrRefreshByWorkspace.set(workspaceId, now);

    void dependencies.prSnapshotService
      .refreshWorkspace(workspaceId)
      .then((result) => {
        if (result.success || result.reason === 'no_pr_url') {
          return;
        }
        state.logger.debug('Idle PR snapshot refresh did not return fresh data', {
          workspaceId,
          reason: result.reason,
        });
      })
      .catch((error) => {
        state.logger.debug('Idle PR snapshot refresh failed', {
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  // 1. Workspace state changes
  const workspaceStateChangedHandler = (event: WorkspaceStateChangedEvent) => {
    if (event.toStatus === 'ARCHIVED') {
      archivedProjectionWorkspaceIds.add(event.workspaceId);
      ratchetProjectionRefreshes.delete(event.workspaceId);
      // Immediate removal for UI feedback -- no coalescing delay
      removeWorkspaceWithState(state, event.workspaceId);
      void Promise.allSettled([
        dependencies.sessionService.stopWorkspaceSessions(event.workspaceId),
        Promise.resolve().then(() => {
          dependencies.terminalService.destroyWorkspaceTerminals(event.workspaceId);
        }),
      ]).then((results) => {
        const cleanupErrors = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );

        if (cleanupErrors.length > 0) {
          state.logger.warn(
            'Failed to cleanup archived workspace resources from state change event',
            {
              workspaceId: event.workspaceId,
              errors: cleanupErrors.map((error) =>
                error instanceof Error ? error.message : String(error)
              ),
            }
          );
        }
      });
      return;
    }
    archivedProjectionWorkspaceIds.delete(event.workspaceId);
    coalescer.enqueue(
      event.workspaceId,
      buildWorkspaceStateChangeFields(event),
      'event:workspace_state_changed',
      { immediate: true }
    );
  };
  dependencies.workspaceStateMachine.on(WORKSPACE_STATE_CHANGED, workspaceStateChangedHandler);
  state.teardownListeners.push(() =>
    dependencies.workspaceStateMachine.off(WORKSPACE_STATE_CHANGED, workspaceStateChangedHandler)
  );

  // 2. PR snapshot updates
  const prSnapshotUpdatedHandler = (event: PRSnapshotUpdatedEvent) => {
    const previousSnapshot = dependencies.workspaceSnapshotStore.getByWorkspaceId(
      event.workspaceId
    );
    const shouldRefreshRatchet = shouldRefreshRatchetForPrSwitch(previousSnapshot, event);
    const snapshotUpdate: SnapshotUpdateInput = {
      ...(event.prUrl !== undefined ? { prUrl: event.prUrl } : {}),
      prNumber: event.prNumber,
      prState: event.prState as PRState,
      prCiStatus: event.prCiStatus as CIStatus,
    };

    coalescer.enqueue(event.workspaceId, snapshotUpdate, 'event:pr_snapshot_updated', {
      immediate: true,
    });

    if (event.ratchetDispatchChanged) {
      requestAuthoritativeRatchetProjection(event.workspaceId);
    }

    if (shouldRefreshRatchet) {
      // Bypass the PR-fetch cooldown: this event was emitted by a sync that
      // just registered its own fetch, so a plain check would be deduped into
      // a no-op and the "immediate" refresh would wait for the next poll.
      void dependencies.ratchetService
        .checkWorkspaceById(event.workspaceId, { bypassPrFetchCooldown: true })
        .catch((error) => {
          state.logger.warn('Failed immediate ratchet refresh after PR switch', {
            workspaceId: event.workspaceId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    // Closed PRs are excluded from the ratchet poll set, so the poll loop can no
    // longer settle their ratchet state; reset it directly (no GitHub fetch needed).
    if (event.prState === 'CLOSED') {
      void dependencies.ratchetService.markPrClosed(event.workspaceId).catch((error) => {
        state.logger.warn('Failed to reset ratchet state for closed PR', {
          workspaceId: event.workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    // Transition linked Linear issue to completed when PR is merged
    if (event.prState === 'MERGED') {
      void handleLinearIssueCompletedOnMerge(state, event.workspaceId);
    }
  };
  dependencies.prSnapshotService.on(PR_SNAPSHOT_UPDATED, prSnapshotUpdatedHandler);
  state.teardownListeners.push(() =>
    dependencies.prSnapshotService.off(PR_SNAPSHOT_UPDATED, prSnapshotUpdatedHandler)
  );

  const prDispatchInvalidatedHandler = (event: PRDispatchInvalidatedEvent) => {
    requestAuthoritativeRatchetProjection(event.workspaceId);
    refreshCachedKanbanColumn(state, event.workspaceId);
  };
  dependencies.prSnapshotService.on(PR_DISPATCH_INVALIDATED, prDispatchInvalidatedHandler);
  state.teardownListeners.push(() =>
    dependencies.prSnapshotService.off(PR_DISPATCH_INVALIDATED, prDispatchInvalidatedHandler)
  );

  // 3. Ratchet state changes
  const ratchetStateChangedHandler = (event: RatchetStateChangedEvent) => {
    if (event.prCiStatus !== undefined) {
      coalescer.enqueue(
        event.workspaceId,
        { prCiStatus: event.prCiStatus },
        'event:ratchet_state_changed',
        { immediate: true }
      );
    }
    requestAuthoritativeRatchetProjection(event.workspaceId);
    refreshCachedKanbanColumn(state, event.workspaceId);
  };
  dependencies.ratchetService.on(RATCHET_STATE_CHANGED, ratchetStateChangedHandler);
  state.teardownListeners.push(() =>
    dependencies.ratchetService.off(RATCHET_STATE_CHANGED, ratchetStateChangedHandler)
  );

  // 4. Ratchet enabled/disabled toggles
  const ratchetToggledHandler = (event: RatchetToggledEvent) => {
    coalescer.enqueue(
      event.workspaceId,
      { ratchetEnabled: event.enabled, ratchetState: event.ratchetState },
      'event:ratchet_toggled',
      { immediate: true }
    );
    requestAuthoritativeRatchetProjection(event.workspaceId);
    refreshCachedKanbanColumn(state, event.workspaceId);
  };
  dependencies.ratchetService.on(RATCHET_TOGGLED, ratchetToggledHandler);
  state.teardownListeners.push(() =>
    dependencies.ratchetService.off(RATCHET_TOGGLED, ratchetToggledHandler)
  );

  // 5. Ratchet dispatch ownership changes
  const ratchetDispatchChangedHandler = (event: RatchetDispatchChangedEvent) => {
    requestAuthoritativeRatchetProjection(event.workspaceId);
    refreshCachedKanbanColumn(state, event.workspaceId);
  };
  dependencies.ratchetService.on(RATCHET_DISPATCH_CHANGED, ratchetDispatchChangedHandler);
  state.teardownListeners.push(() =>
    dependencies.ratchetService.off(RATCHET_DISPATCH_CHANGED, ratchetDispatchChangedHandler)
  );

  // 6. Run-script status changes
  const runScriptStatusChangedHandler = (event: RunScriptStatusChangedEvent) => {
    coalescer.enqueue(
      event.workspaceId,
      { runScriptStatus: event.toStatus },
      'event:run_script_status_changed'
    );
  };
  dependencies.runScriptStateMachine.on(RUN_SCRIPT_STATUS_CHANGED, runScriptStatusChangedHandler);
  state.teardownListeners.push(() =>
    dependencies.runScriptStateMachine.off(RUN_SCRIPT_STATUS_CHANGED, runScriptStatusChangedHandler)
  );

  // 6. Workspace activity (active)
  const workspaceActiveHandler = ({ workspaceId }: { workspaceId: string }) => {
    coalescer.enqueue(
      workspaceId,
      { isWorking: true, hasHadSessions: true },
      'event:workspace_active',
      { immediate: true }
    );
  };
  dependencies.workspaceActivityService.on('workspace_active', workspaceActiveHandler);
  state.teardownListeners.push(() =>
    dependencies.workspaceActivityService.off('workspace_active', workspaceActiveHandler)
  );

  // 7. Workspace activity (idle)
  const workspaceIdleHandler = ({ workspaceId }: { workspaceId: string }) => {
    coalescer.enqueue(
      workspaceId,
      { isWorking: false, hasHadSessions: true },
      'event:workspace_idle',
      { immediate: true }
    );
    refreshPrSnapshotOnIdle(workspaceId);
  };
  dependencies.workspaceActivityService.on('workspace_idle', workspaceIdleHandler);
  state.teardownListeners.push(() =>
    dependencies.workspaceActivityService.off('workspace_idle', workspaceIdleHandler)
  );

  // 8. Session-level activity changes (running/idle transitions)
  const sessionActivityChangedHandler = ({
    workspaceId,
  }: {
    workspaceId: string;
    sessionId: string;
    isWorking: boolean;
  }) => {
    void refreshWorkspaceSessionSummaries(
      state,
      coalescer,
      workspaceId,
      'event:session_activity_changed',
      { includeWorking: true }
    );
  };
  dependencies.workspaceActivityService.on(
    'session_activity_changed',
    sessionActivityChangedHandler
  );
  state.teardownListeners.push(() =>
    dependencies.workspaceActivityService.off(
      'session_activity_changed',
      sessionActivityChangedHandler
    )
  );

  // 9. Prime session summaries on startup so fresh clients have tab runtime
  // state before the first activity transition or reconciliation tick.
  for (const workspaceId of dependencies.workspaceSnapshotStore.getAllWorkspaceIds()) {
    void refreshWorkspaceSessionSummaries(
      state,
      coalescer,
      workspaceId,
      'event:collector_startup',
      {
        includeWorking: true,
      }
    );
  }

  // 10. Pending interactive request transitions (set/clear)
  const pendingRequestChangedHandler = ({ sessionId }: PendingRequestChangedEvent) => {
    void refreshWorkspacePendingRequestType(
      state,
      coalescer,
      sessionId,
      'event:pending_request_changed'
    );
  };
  dependencies.sessionDomainService.on('pending_request_changed', pendingRequestChangedHandler);
  state.teardownListeners.push(() =>
    dependencies.sessionDomainService.off('pending_request_changed', pendingRequestChangedHandler)
  );
  const runtimeChangedHandler = ({ sessionId }: { sessionId: string }) => {
    void refreshWorkspaceSessionSummariesForSession(
      state,
      coalescer,
      sessionId,
      'event:session_runtime_changed'
    );
  };
  dependencies.sessionDomainService.on('runtime_changed', runtimeChangedHandler);
  state.teardownListeners.push(() =>
    dependencies.sessionDomainService.off('runtime_changed', runtimeChangedHandler)
  );

  state.logger.info('Event collector started with 12 event subscriptions');
}

// ---------------------------------------------------------------------------
// stopEventCollector
// ---------------------------------------------------------------------------

/**
 * Flush all pending coalesced updates and release the coalescer.
 * Called during server shutdown before domain services stop.
 */
function stopEventCollectorWithState(state: EventCollectorState): void {
  for (const teardown of state.teardownListeners.splice(0).reverse()) {
    teardown();
  }
  state.stopRatchetProjection?.();
  state.stopRatchetProjection = null;

  if (state.activeCoalescer) {
    state.activeCoalescer.flushAll();
    state.activeCoalescer = null;
    state.lastIdlePrRefreshByWorkspace.clear();
    state.logger.info('Event collector stopped');
  }
}

export class EventCollectorOrchestrator {
  private readonly state: EventCollectorState;

  constructor(dependencies: Readonly<EventCollectorDependencies>) {
    this.state = new EventCollectorState(dependencies);
  }

  start(): void {
    startEventCollectorWithState(this.state);
  }

  stop(): void {
    stopEventCollectorWithState(this.state);
  }

  removeWorkspace(workspaceId: string): void {
    removeWorkspaceWithState(this.state, workspaceId);
  }
}

export function createEventCollectorOrchestrator(
  dependencies: Readonly<EventCollectorDependencies>
): EventCollectorOrchestrator {
  return new EventCollectorOrchestrator(dependencies);
}

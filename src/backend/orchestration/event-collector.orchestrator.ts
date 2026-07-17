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
 * - Domain singletons and event constants from domain barrels
 * - Store from @/backend/services/workspace-snapshot-store.service
 * - NOT re-exported from orchestration/index.ts (circular dep risk)
 */

import {
  buildWorkspaceSessionSummaries,
  hasWorkingSessionSummary,
} from '@/backend/lib/session-summaries';
import {
  PR_SNAPSHOT_UPDATED,
  type PRSnapshotUpdatedEvent,
  prSnapshotService,
} from '@/backend/services/github';
import { linearStateSyncService } from '@/backend/services/linear';
import { createLogger } from '@/backend/services/logger.service';
import {
  RATCHET_DISPATCH_CHANGED,
  RATCHET_STATE_CHANGED,
  RATCHET_TOGGLED,
  type RatchetDispatchChangedEvent,
  type RatchetStateChangedEvent,
  type RatchetToggledEvent,
  ratchetService,
} from '@/backend/services/ratchet';
import {
  RUN_SCRIPT_STATUS_CHANGED,
  type RunScriptStatusChangedEvent,
  runScriptStateMachine,
} from '@/backend/services/run-script';
import {
  chatEventForwarderService,
  sessionDataService,
  sessionDomainService,
  sessionService,
} from '@/backend/services/session';
import { terminalService } from '@/backend/services/terminal';
import {
  computePendingRequestType,
  kanbanStateService,
  WORKSPACE_STATE_CHANGED,
  type WorkspaceStateChangedEvent,
  workspaceAccessor,
  workspaceActivityService,
  workspaceStateMachine,
} from '@/backend/services/workspace';
import {
  type SnapshotUpdateInput,
  workspaceSnapshotStore,
} from '@/backend/services/workspace-snapshot-store.service';
import type { CIStatus, PRState } from '@/shared/core';
import { getWorkspaceLinearContext } from './linear-config.helper';

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
  getByWorkspaceId(workspaceId: string): { projectId: string } | undefined;
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
// Logger
// ---------------------------------------------------------------------------

const logger = createLogger('event-collector');

// ---------------------------------------------------------------------------
// EventCoalescer
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_MS = 150;
const IDLE_PR_REFRESH_COOLDOWN_MS = 30_000;
let lastCoalescerTimestamp = 0;

function nextCoalescerTimestamp(): number {
  const timestamp = Math.max(Date.now(), lastCoalescerTimestamp + 1);
  lastCoalescerTimestamp = timestamp;
  return timestamp;
}

function refreshCachedKanbanColumn(workspaceId: string): void {
  void kanbanStateService.updateCachedKanbanColumn(workspaceId).catch((error) => {
    logger.warn('Failed to refresh cached kanban column after Ratchet change', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function projectAuthoritativeRatchetState(
  coalescer: EventCoalescer,
  workspaceId: string,
  isActive: () => boolean
): Promise<void> {
  try {
    const workspace = await workspaceAccessor.findRawById(workspaceId);
    if (!(workspace && isActive())) {
      return;
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
  } catch (error) {
    logger.warn('Failed to refresh authoritative Ratchet snapshot projection', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

type EventCollectorSessionServices = {
  chatEventForwarderService: typeof chatEventForwarderService;
  sessionDataService: typeof sessionDataService;
  sessionDomainService: typeof sessionDomainService;
  sessionService: typeof sessionService;
  terminalService: typeof terminalService;
};

const defaultSessionServices: EventCollectorSessionServices = {
  chatEventForwarderService,
  sessionDataService,
  sessionDomainService,
  sessionService,
  terminalService,
};

function shouldRefreshRatchetForPrSwitch(
  previousSnapshot: ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>,
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
    private windowMs = DEFAULT_WINDOW_MS
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
      logger.debug('Skipping upsert for unknown workspace (awaiting reconciliation)', {
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
        logger.debug('Skipping upsert for unknown workspace during flushAll', {
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
  activeCoalescer: EventCoalescer | null = null;
  pendingRequestChangedHandler: ((event: PendingRequestChangedEvent) => void) | null = null;
  runtimeChangedHandler: ((event: { sessionId: string }) => void) | null = null;
  ratchetDispatchChangedHandler: ((event: RatchetDispatchChangedEvent) => void) | null = null;
  eventCollectorSessionServices: EventCollectorSessionServices = defaultSessionServices;
  listenerSessionDomainService: EventCollectorSessionServices['sessionDomainService'] | null = null;
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
      await state.eventCollectorSessionServices.sessionDataService.findAgentSessionsByWorkspaceId(
        workspaceId
      );
    if (state.activeCoalescer !== coalescer) {
      return;
    }
    const sessionSummaries = buildWorkspaceSessionSummaries(sessions, (sessionId) =>
      state.eventCollectorSessionServices.sessionService.getRuntimeSnapshot(sessionId)
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
    logger.warn('Failed to refresh workspace session summaries', {
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
    const session =
      await state.eventCollectorSessionServices.sessionDataService.findAgentSessionById(sessionId);
    if (!session || state.activeCoalescer !== coalescer) {
      return;
    }

    const sessions =
      await state.eventCollectorSessionServices.sessionDataService.findAgentSessionsByWorkspaceId(
        session.workspaceId
      );
    if (state.activeCoalescer !== coalescer) {
      return;
    }

    const pendingRequestType = computePendingRequestType(
      sessions.map((s) => s.id),
      state.eventCollectorSessionServices.chatEventForwarderService.getAllPendingRequests()
    );
    coalescer.enqueue(session.workspaceId, { pendingRequestType }, source);
  } catch (error) {
    logger.warn('Failed to refresh workspace pending request type', {
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
    const session =
      await state.eventCollectorSessionServices.sessionDataService.findAgentSessionById(sessionId);
    if (!session || state.activeCoalescer !== coalescer) {
      return;
    }
    await refreshWorkspaceSessionSummaries(state, coalescer, session.workspaceId, source, {
      includeWorking: true,
    });
  } catch (error) {
    logger.warn('Failed to refresh workspace session summaries from runtime change', {
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

async function handleLinearIssueCompletedOnMerge(workspaceId: string): Promise<void> {
  try {
    const ctx = await getWorkspaceLinearContext(workspaceId);
    if (!ctx) {
      return;
    }

    await linearStateSyncService.markIssueCompleted(ctx.apiKey, ctx.linearIssueId);
    logger.info('Marked Linear issue as completed on PR merge', {
      workspaceId,
      linearIssueId: ctx.linearIssueId,
    });
  } catch (error) {
    logger.warn('Failed to mark Linear issue as completed on PR merge', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// configureEventCollector
// ---------------------------------------------------------------------------

/**
 * Subscribe to all domain event sources and route events through the
 * coalescing buffer to the snapshot store.
 *
 * Must be called AFTER configureDomainBridges() in server startup.
 */
function configureEventCollectorWithState(
  state: EventCollectorState,
  services: Partial<EventCollectorSessionServices> = {}
): void {
  const previousSessionDomainService =
    state.listenerSessionDomainService ?? state.eventCollectorSessionServices.sessionDomainService;

  // Guard against duplicate listeners across repeated configure calls.
  if (state.pendingRequestChangedHandler) {
    previousSessionDomainService.off('pending_request_changed', state.pendingRequestChangedHandler);
    state.pendingRequestChangedHandler = null;
  }
  if (state.runtimeChangedHandler) {
    previousSessionDomainService.off('runtime_changed', state.runtimeChangedHandler);
    state.runtimeChangedHandler = null;
  }
  if (state.ratchetDispatchChangedHandler) {
    ratchetService.off(RATCHET_DISPATCH_CHANGED, state.ratchetDispatchChangedHandler);
    state.ratchetDispatchChangedHandler = null;
  }

  state.eventCollectorSessionServices = {
    ...defaultSessionServices,
    ...services,
  };
  const coalescer = new EventCoalescer(workspaceSnapshotStore);
  state.activeCoalescer = coalescer;
  const lastIdlePrRefreshByWorkspace = new Map<string, number>();
  const ratchetProjectionRefreshes = new Map<string, { dirty: boolean }>();

  const requestAuthoritativeRatchetProjection = (workspaceId: string): void => {
    const existing = ratchetProjectionRefreshes.get(workspaceId);
    if (existing) {
      existing.dirty = true;
      return;
    }

    const refresh = { dirty: true };
    ratchetProjectionRefreshes.set(workspaceId, refresh);
    void (async () => {
      try {
        while (refresh.dirty) {
          refresh.dirty = false;
          await projectAuthoritativeRatchetState(
            coalescer,
            workspaceId,
            () => state.activeCoalescer === coalescer
          );
        }
      } finally {
        if (ratchetProjectionRefreshes.get(workspaceId) === refresh) {
          ratchetProjectionRefreshes.delete(workspaceId);
        }
      }
    })();
  };

  const refreshPrSnapshotOnIdle = (workspaceId: string): void => {
    const now = Date.now();
    const lastRefresh = lastIdlePrRefreshByWorkspace.get(workspaceId) ?? 0;
    if (now - lastRefresh < IDLE_PR_REFRESH_COOLDOWN_MS) {
      return;
    }
    lastIdlePrRefreshByWorkspace.set(workspaceId, now);

    void prSnapshotService
      .refreshWorkspace(workspaceId)
      .then((result) => {
        if (result.success || result.reason === 'no_pr_url') {
          return;
        }
        logger.debug('Idle PR snapshot refresh did not return fresh data', {
          workspaceId,
          reason: result.reason,
        });
      })
      .catch((error) => {
        logger.debug('Idle PR snapshot refresh failed', {
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  // 1. Workspace state changes
  workspaceStateMachine.on(WORKSPACE_STATE_CHANGED, (event: WorkspaceStateChangedEvent) => {
    if (event.toStatus === 'ARCHIVED') {
      // Immediate removal for UI feedback -- no coalescing delay
      workspaceSnapshotStore.remove(event.workspaceId);
      workspaceActivityService.clearWorkspace(event.workspaceId);
      void Promise.allSettled([
        state.eventCollectorSessionServices.sessionService.stopWorkspaceSessions(event.workspaceId),
        Promise.resolve().then(() => {
          state.eventCollectorSessionServices.terminalService.destroyWorkspaceTerminals(
            event.workspaceId
          );
        }),
      ]).then((results) => {
        const cleanupErrors = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );

        if (cleanupErrors.length > 0) {
          logger.warn('Failed to cleanup archived workspace resources from state change event', {
            workspaceId: event.workspaceId,
            errors: cleanupErrors.map((error) =>
              error instanceof Error ? error.message : String(error)
            ),
          });
        }
      });
      return;
    }
    coalescer.enqueue(
      event.workspaceId,
      buildWorkspaceStateChangeFields(event),
      'event:workspace_state_changed',
      { immediate: true }
    );
  });

  // 2. PR snapshot updates
  prSnapshotService.on(PR_SNAPSHOT_UPDATED, (event: PRSnapshotUpdatedEvent) => {
    const previousSnapshot = workspaceSnapshotStore.getByWorkspaceId(event.workspaceId);
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
      void ratchetService
        .checkWorkspaceById(event.workspaceId, { bypassPrFetchCooldown: true })
        .catch((error) => {
          logger.warn('Failed immediate ratchet refresh after PR switch', {
            workspaceId: event.workspaceId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    // Closed PRs are excluded from the ratchet poll set, so the poll loop can no
    // longer settle their ratchet state; reset it directly (no GitHub fetch needed).
    if (event.prState === 'CLOSED') {
      void ratchetService.markPrClosed(event.workspaceId).catch((error) => {
        logger.warn('Failed to reset ratchet state for closed PR', {
          workspaceId: event.workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    // Transition linked Linear issue to completed when PR is merged
    if (event.prState === 'MERGED') {
      void handleLinearIssueCompletedOnMerge(event.workspaceId);
    }
  });

  // 3. Ratchet state changes
  ratchetService.on(RATCHET_STATE_CHANGED, (event: RatchetStateChangedEvent) => {
    coalescer.enqueue(
      event.workspaceId,
      {
        ratchetState: event.toState,
        // Include fresh prCiStatus when the ratchet observed a CI status change.
        // Prevents stale "CI Running" display after CI completes between scheduler polls.
        ...(event.prCiStatus !== undefined ? { prCiStatus: event.prCiStatus } : {}),
      },
      'event:ratchet_state_changed',
      { immediate: true }
    );
    refreshCachedKanbanColumn(event.workspaceId);
  });

  // 4. Ratchet enabled/disabled toggles
  ratchetService.on(RATCHET_TOGGLED, (event: RatchetToggledEvent) => {
    coalescer.enqueue(
      event.workspaceId,
      {
        ratchetEnabled: event.enabled,
        ratchetState: event.ratchetState,
      },
      'event:ratchet_toggled',
      { immediate: true }
    );
    requestAuthoritativeRatchetProjection(event.workspaceId);
    refreshCachedKanbanColumn(event.workspaceId);
  });

  // 5. Ratchet dispatch ownership changes
  state.ratchetDispatchChangedHandler = (event: RatchetDispatchChangedEvent) => {
    requestAuthoritativeRatchetProjection(event.workspaceId);
    refreshCachedKanbanColumn(event.workspaceId);
  };
  ratchetService.on(RATCHET_DISPATCH_CHANGED, state.ratchetDispatchChangedHandler);

  // 6. Run-script status changes
  runScriptStateMachine.on(RUN_SCRIPT_STATUS_CHANGED, (event: RunScriptStatusChangedEvent) => {
    coalescer.enqueue(
      event.workspaceId,
      { runScriptStatus: event.toStatus },
      'event:run_script_status_changed'
    );
  });

  // 7. Workspace activity (active)
  workspaceActivityService.on('workspace_active', ({ workspaceId }: { workspaceId: string }) => {
    coalescer.enqueue(
      workspaceId,
      { isWorking: true, hasHadSessions: true },
      'event:workspace_active',
      { immediate: true }
    );
  });

  // 8. Workspace activity (idle)
  workspaceActivityService.on('workspace_idle', ({ workspaceId }: { workspaceId: string }) => {
    coalescer.enqueue(
      workspaceId,
      { isWorking: false, hasHadSessions: true },
      'event:workspace_idle',
      { immediate: true }
    );
    refreshPrSnapshotOnIdle(workspaceId);
  });

  // 9. Session-level activity changes (running/idle transitions)
  workspaceActivityService.on(
    'session_activity_changed',
    ({ workspaceId }: { workspaceId: string; sessionId: string; isWorking: boolean }) => {
      void refreshWorkspaceSessionSummaries(
        state,
        coalescer,
        workspaceId,
        'event:session_activity_changed',
        { includeWorking: true }
      );
    }
  );

  // 10. Prime session summaries on startup so fresh clients have tab runtime
  // state before the first activity transition or reconciliation tick.
  for (const workspaceId of workspaceSnapshotStore.getAllWorkspaceIds()) {
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

  // 11. Pending interactive request transitions (set/clear)
  state.pendingRequestChangedHandler = ({ sessionId }) => {
    void refreshWorkspacePendingRequestType(
      state,
      coalescer,
      sessionId,
      'event:pending_request_changed'
    );
  };
  state.eventCollectorSessionServices.sessionDomainService.on(
    'pending_request_changed',
    state.pendingRequestChangedHandler
  );
  state.runtimeChangedHandler = ({ sessionId }) => {
    void refreshWorkspaceSessionSummariesForSession(
      state,
      coalescer,
      sessionId,
      'event:session_runtime_changed'
    );
  };
  state.eventCollectorSessionServices.sessionDomainService.on(
    'runtime_changed',
    state.runtimeChangedHandler
  );
  state.listenerSessionDomainService = state.eventCollectorSessionServices.sessionDomainService;

  logger.info('Event collector configured with 11 event subscriptions');
}

// ---------------------------------------------------------------------------
// stopEventCollector
// ---------------------------------------------------------------------------

/**
 * Flush all pending coalesced updates and release the coalescer.
 * Called during server shutdown before domain services stop.
 */
function stopEventCollectorWithState(state: EventCollectorState): void {
  const sessionDomainService =
    state.listenerSessionDomainService ?? state.eventCollectorSessionServices.sessionDomainService;

  if (state.pendingRequestChangedHandler) {
    sessionDomainService.off('pending_request_changed', state.pendingRequestChangedHandler);
    state.pendingRequestChangedHandler = null;
  }
  if (state.runtimeChangedHandler) {
    sessionDomainService.off('runtime_changed', state.runtimeChangedHandler);
    state.runtimeChangedHandler = null;
  }
  if (state.ratchetDispatchChangedHandler) {
    ratchetService.off(RATCHET_DISPATCH_CHANGED, state.ratchetDispatchChangedHandler);
    state.ratchetDispatchChangedHandler = null;
  }
  state.listenerSessionDomainService = null;

  if (state.activeCoalescer) {
    state.activeCoalescer.flushAll();
    state.activeCoalescer = null;
    logger.info('Event collector stopped');
  }
}

export class EventCollectorOrchestrator {
  private readonly state = new EventCollectorState();

  configure(services: Partial<EventCollectorSessionServices> = {}): void {
    configureEventCollectorWithState(this.state, services);
  }

  stop(): void {
    stopEventCollectorWithState(this.state);
  }
}

export function createEventCollectorOrchestrator(): EventCollectorOrchestrator {
  return new EventCollectorOrchestrator();
}

const defaultEventCollectorOrchestrator = createEventCollectorOrchestrator();

export function configureEventCollector(
  services: Partial<EventCollectorSessionServices> = {}
): void {
  defaultEventCollectorOrchestrator.configure(services);
}

export function stopEventCollector(): void {
  defaultEventCollectorOrchestrator.stop();
}

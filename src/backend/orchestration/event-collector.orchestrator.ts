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
  PR_SNAPSHOT_UPDATED,
  type PRSnapshotUpdatedEvent,
  prSnapshotService,
} from '@/backend/domains/github';
import { linearStateSyncService } from '@/backend/domains/linear';
import {
  RATCHET_STATE_CHANGED,
  RATCHET_TOGGLED,
  type RatchetStateChangedEvent,
  type RatchetToggledEvent,
  ratchetService,
} from '@/backend/domains/ratchet';
import {
  RUN_SCRIPT_STATUS_CHANGED,
  type RunScriptStatusChangedEvent,
  runScriptStateMachine,
} from '@/backend/domains/run-script';
import {
  chatEventForwarderService,
  sessionDataService,
  sessionDomainService,
  sessionService,
} from '@/backend/domains/session';
import {
  computePendingRequestType,
  WORKSPACE_STATE_CHANGED,
  type WorkspaceStateChangedEvent,
  workspaceActivityService,
  workspaceStateMachine,
} from '@/backend/domains/workspace';
import {
  buildWorkspaceSessionSummaries,
  hasWorkingSessionSummary,
} from '@/backend/lib/session-summaries';
import { createLogger } from '@/backend/services/logger.service';
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
  upsert(workspaceId: string, update: SnapshotUpdateInput, source: string): void;
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

type EventCollectorSessionServices = {
  chatEventForwarderService: typeof chatEventForwarderService;
  sessionDataService: typeof sessionDataService;
  sessionDomainService: typeof sessionDomainService;
  sessionService: typeof sessionService;
};

const defaultSessionServices: EventCollectorSessionServices = {
  chatEventForwarderService,
  sessionDataService,
  sessionDomainService,
  sessionService,
};

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
    this.store.upsert(workspaceId, pending.fields, source);
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
      this.store.upsert(workspaceId, pending.fields, source);
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

let activeCoalescer: EventCoalescer | null = null;
let pendingRequestChangedHandler: ((event: PendingRequestChangedEvent) => void) | null = null;
let runtimeChangedHandler: ((event: { sessionId: string }) => void) | null = null;
let eventCollectorSessionServices: EventCollectorSessionServices = defaultSessionServices;
let listenerSessionDomainService: EventCollectorSessionServices['sessionDomainService'] | null =
  null;

async function refreshWorkspaceSessionSummaries(
  coalescer: EventCoalescer,
  workspaceId: string,
  source: string,
  options?: { includeWorking?: boolean }
): Promise<void> {
  try {
    if (activeCoalescer !== coalescer) {
      return;
    }
    const sessions =
      await eventCollectorSessionServices.sessionDataService.findAgentSessionsByWorkspaceId(
        workspaceId
      );
    if (activeCoalescer !== coalescer) {
      return;
    }
    const sessionSummaries = buildWorkspaceSessionSummaries(sessions, (sessionId) =>
      eventCollectorSessionServices.sessionService.getRuntimeSnapshot(sessionId)
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
  coalescer: EventCoalescer,
  sessionId: string,
  source: string
): Promise<void> {
  try {
    if (activeCoalescer !== coalescer) {
      return;
    }
    const session =
      await eventCollectorSessionServices.sessionDataService.findAgentSessionById(sessionId);
    if (!session || activeCoalescer !== coalescer) {
      return;
    }

    const sessions =
      await eventCollectorSessionServices.sessionDataService.findAgentSessionsByWorkspaceId(
        session.workspaceId
      );
    if (activeCoalescer !== coalescer) {
      return;
    }

    const pendingRequestType = computePendingRequestType(
      sessions.map((s) => s.id),
      eventCollectorSessionServices.chatEventForwarderService.getAllPendingRequests()
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
  coalescer: EventCoalescer,
  sessionId: string,
  source: string
): Promise<void> {
  try {
    if (activeCoalescer !== coalescer) {
      return;
    }
    const session =
      await eventCollectorSessionServices.sessionDataService.findAgentSessionById(sessionId);
    if (!session || activeCoalescer !== coalescer) {
      return;
    }
    await refreshWorkspaceSessionSummaries(coalescer, session.workspaceId, source, {
      includeWorking: true,
    });
  } catch (error) {
    logger.warn('Failed to refresh workspace session summaries from runtime change', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
export function configureEventCollector(
  services: Partial<EventCollectorSessionServices> = {}
): void {
  const previousSessionDomainService =
    listenerSessionDomainService ?? eventCollectorSessionServices.sessionDomainService;

  // Guard against duplicate listeners across repeated configure calls.
  if (pendingRequestChangedHandler) {
    previousSessionDomainService.off('pending_request_changed', pendingRequestChangedHandler);
    pendingRequestChangedHandler = null;
  }
  if (runtimeChangedHandler) {
    previousSessionDomainService.off('runtime_changed', runtimeChangedHandler);
    runtimeChangedHandler = null;
  }

  eventCollectorSessionServices = {
    ...defaultSessionServices,
    ...services,
  };
  const coalescer = new EventCoalescer(workspaceSnapshotStore);
  activeCoalescer = coalescer;
  const lastIdlePrRefreshByWorkspace = new Map<string, number>();

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
      return;
    }
    coalescer.enqueue(
      event.workspaceId,
      { status: event.toStatus },
      'event:workspace_state_changed',
      { immediate: true }
    );
  });

  // 2. PR snapshot updates
  prSnapshotService.on(PR_SNAPSHOT_UPDATED, (event: PRSnapshotUpdatedEvent) => {
    const snapshotUpdate: SnapshotUpdateInput = {
      ...(event.prUrl !== undefined ? { prUrl: event.prUrl } : {}),
      prNumber: event.prNumber,
      prState: event.prState as PRState,
      prCiStatus: event.prCiStatus as CIStatus,
    };

    coalescer.enqueue(event.workspaceId, snapshotUpdate, 'event:pr_snapshot_updated', {
      immediate: true,
    });

    // Transition linked Linear issue to completed when PR is merged
    if (event.prState === 'MERGED') {
      void handleLinearIssueCompletedOnMerge(event.workspaceId);
    }
  });

  // 3. Ratchet state changes
  ratchetService.on(RATCHET_STATE_CHANGED, (event: RatchetStateChangedEvent) => {
    coalescer.enqueue(
      event.workspaceId,
      { ratchetState: event.toState },
      'event:ratchet_state_changed',
      { immediate: true }
    );
  });

  // 4. Ratchet enabled/disabled toggles
  ratchetService.on(RATCHET_TOGGLED, (event: RatchetToggledEvent) => {
    coalescer.enqueue(
      event.workspaceId,
      { ratchetEnabled: event.enabled, ratchetState: event.ratchetState },
      'event:ratchet_toggled',
      { immediate: true }
    );
  });

  // 5. Run-script status changes
  runScriptStateMachine.on(RUN_SCRIPT_STATUS_CHANGED, (event: RunScriptStatusChangedEvent) => {
    coalescer.enqueue(
      event.workspaceId,
      { runScriptStatus: event.toStatus },
      'event:run_script_status_changed'
    );
  });

  // 6. Workspace activity (active)
  workspaceActivityService.on('workspace_active', ({ workspaceId }: { workspaceId: string }) => {
    coalescer.enqueue(
      workspaceId,
      { isWorking: true, hasHadSessions: true },
      'event:workspace_active',
      { immediate: true }
    );
  });

  // 7. Workspace activity (idle)
  workspaceActivityService.on('workspace_idle', ({ workspaceId }: { workspaceId: string }) => {
    coalescer.enqueue(
      workspaceId,
      { isWorking: false, hasHadSessions: true },
      'event:workspace_idle',
      { immediate: true }
    );
    refreshPrSnapshotOnIdle(workspaceId);
  });

  // 8. Session-level activity changes (running/idle transitions)
  workspaceActivityService.on(
    'session_activity_changed',
    ({ workspaceId }: { workspaceId: string; sessionId: string; isWorking: boolean }) => {
      void refreshWorkspaceSessionSummaries(
        coalescer,
        workspaceId,
        'event:session_activity_changed',
        { includeWorking: true }
      );
    }
  );

  // 9. Prime session summaries on startup so fresh clients have tab runtime
  // state before the first activity transition or reconciliation tick.
  for (const workspaceId of workspaceSnapshotStore.getAllWorkspaceIds()) {
    void refreshWorkspaceSessionSummaries(coalescer, workspaceId, 'event:collector_startup', {
      includeWorking: true,
    });
  }

  // 10. Pending interactive request transitions (set/clear)
  pendingRequestChangedHandler = ({ sessionId }) => {
    void refreshWorkspacePendingRequestType(coalescer, sessionId, 'event:pending_request_changed');
  };
  eventCollectorSessionServices.sessionDomainService.on(
    'pending_request_changed',
    pendingRequestChangedHandler
  );
  runtimeChangedHandler = ({ sessionId }) => {
    void refreshWorkspaceSessionSummariesForSession(
      coalescer,
      sessionId,
      'event:session_runtime_changed'
    );
  };
  eventCollectorSessionServices.sessionDomainService.on('runtime_changed', runtimeChangedHandler);
  listenerSessionDomainService = eventCollectorSessionServices.sessionDomainService;

  logger.info('Event collector configured with 10 event subscriptions');
}

// ---------------------------------------------------------------------------
// stopEventCollector
// ---------------------------------------------------------------------------

/**
 * Flush all pending coalesced updates and release the coalescer.
 * Called during server shutdown before domain services stop.
 */
export function stopEventCollector(): void {
  const sessionDomainService =
    listenerSessionDomainService ?? eventCollectorSessionServices.sessionDomainService;

  if (pendingRequestChangedHandler) {
    sessionDomainService.off('pending_request_changed', pendingRequestChangedHandler);
    pendingRequestChangedHandler = null;
  }
  if (runtimeChangedHandler) {
    sessionDomainService.off('runtime_changed', runtimeChangedHandler);
    runtimeChangedHandler = null;
  }
  listenerSessionDomainService = null;

  if (activeCoalescer) {
    activeCoalescer.flushAll();
    activeCoalescer = null;
    logger.info('Event collector stopped');
  }
}

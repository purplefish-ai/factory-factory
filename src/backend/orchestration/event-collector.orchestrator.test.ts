import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVICE_THRESHOLDS } from '@/backend/services/constants';
import type { SnapshotUpdateInput } from '@/backend/services/workspace-snapshot-store.service';

const { mockLoggerWarn } = vi.hoisted(() => ({ mockLoggerWarn: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Mock store helper type
// ---------------------------------------------------------------------------

interface MockStore {
  upsert: ReturnType<
    typeof vi.fn<(id: string, update: SnapshotUpdateInput, source: string) => void>
  >;
  getByWorkspaceId: ReturnType<typeof vi.fn<(id: string) => { projectId: string } | undefined>>;
  remove: ReturnType<typeof vi.fn<(id: string) => boolean>>;
}

function createMockStore(): MockStore {
  return {
    upsert: vi.fn<(id: string, update: SnapshotUpdateInput, source: string) => void>(),
    getByWorkspaceId: vi
      .fn<(id: string) => { projectId: string } | undefined>()
      .mockReturnValue({ projectId: 'proj-1' }),
    remove: vi.fn<(id: string) => boolean>(),
  };
}

// --- Module mocks ---

vi.mock('@/backend/services/workspace', () => ({
  WORKSPACE_STATE_CHANGED: 'workspace_state_changed',
  workspaceStateMachine: { on: vi.fn(), off: vi.fn() },
  workspaceActivityService: { on: vi.fn(), off: vi.fn(), clearWorkspace: vi.fn() },
  computePendingRequestType: vi.fn().mockReturnValue(null),
  kanbanStateService: { updateCachedKanbanColumn: vi.fn().mockResolvedValue(undefined) },
  workspaceAccessor: { findRawById: vi.fn() },
}));

vi.mock('@/backend/services/github', () => ({
  PR_DISPATCH_INVALIDATED: 'pr_dispatch_invalidated',
  PR_SNAPSHOT_UPDATED: 'pr_snapshot_updated',
  prSnapshotService: {
    on: vi.fn(),
    off: vi.fn(),
    refreshWorkspace: vi.fn().mockResolvedValue({ success: false, reason: 'no_pr_url' }),
  },
}));

vi.mock('@/backend/services/ratchet', () => ({
  RATCHET_DISPATCH_CHANGED: 'ratchet_dispatch_changed',
  RATCHET_STATE_CHANGED: 'ratchet_state_changed',
  RATCHET_TOGGLED: 'ratchet_toggled',
  ratchetService: {
    on: vi.fn(),
    off: vi.fn(),
    checkWorkspaceById: vi.fn().mockResolvedValue(null),
    markPrClosed: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/backend/services/run-script', () => ({
  RUN_SCRIPT_STATUS_CHANGED: 'run_script_status_changed',
  runScriptStateMachine: { on: vi.fn(), off: vi.fn() },
}));

vi.mock('@/backend/services/session', () => ({
  sessionDataService: {
    findAgentSessionById: vi.fn().mockResolvedValue({ id: 's-1', workspaceId: 'ws-1' }),
    findAgentSessionsByWorkspaceId: vi.fn().mockResolvedValue([]),
  },
  chatEventForwarderService: {
    getAllPendingRequests: vi.fn().mockReturnValue(new Map()),
  },
  sessionDomainService: {
    on: vi.fn(),
    off: vi.fn(),
  },
  sessionService: {
    getRuntimeSnapshot: vi.fn().mockReturnValue({
      phase: 'idle',
      processState: 'alive',
      activity: 'IDLE',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    stopWorkspaceSessions: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/backend/services/terminal', () => ({
  terminalService: {
    destroyWorkspaceTerminals: vi.fn(),
  },
}));

vi.mock('@/backend/services/workspace-snapshot-store.service', () => ({
  workspaceSnapshotStore: {
    upsert: vi.fn(),
    getByWorkspaceId: vi.fn(),
    getAllWorkspaceIds: vi.fn().mockReturnValue([]),
    remove: vi.fn(),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: mockLoggerWarn,
    error: vi.fn(),
  }),
}));

import { prSnapshotService } from '@/backend/services/github';
import { ratchetService } from '@/backend/services/ratchet';
import { runScriptStateMachine } from '@/backend/services/run-script';
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
  workspaceAccessor,
  workspaceActivityService,
  workspaceStateMachine,
} from '@/backend/services/workspace';
import { workspaceSnapshotStore } from '@/backend/services/workspace-snapshot-store.service';

import {
  configureEventCollector,
  EventCoalescer,
  stopEventCollector,
} from './event-collector.orchestrator';

// ---------------------------------------------------------------------------
// Unit Tests: EventCoalescer
// ---------------------------------------------------------------------------

describe('EventCoalescer', () => {
  let mockStore: MockStore;

  beforeEach(() => {
    vi.useFakeTimers();
    mockStore = createMockStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes single event to upsert after coalescing window', () => {
    const coalescer = new EventCoalescer(mockStore, 150);

    coalescer.enqueue('ws-1', { status: 'READY' as const }, 'event:workspace_state_changed');

    expect(mockStore.upsert).not.toHaveBeenCalled();

    vi.advanceTimersByTime(150);

    expect(mockStore.upsert).toHaveBeenCalledTimes(1);
    expect(mockStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { status: 'READY' },
      'event:workspace_state_changed',
      expect.any(Number)
    );
  });

  it('coalesces rapid-fire events for same workspace into single upsert', () => {
    const coalescer = new EventCoalescer(mockStore, 150);

    coalescer.enqueue('ws-1', { status: 'READY' as const }, 'event:workspace_state_changed');
    vi.advanceTimersByTime(50);

    coalescer.enqueue(
      'ws-1',
      { ratchetState: 'CI_RUNNING' as const },
      'event:ratchet_state_changed'
    );
    vi.advanceTimersByTime(50);

    coalescer.enqueue('ws-1', { isWorking: true }, 'event:workspace_active');

    // Before final timer fires
    expect(mockStore.upsert).not.toHaveBeenCalled();

    // Advance past the coalescing window from last enqueue
    vi.advanceTimersByTime(150);

    expect(mockStore.upsert).toHaveBeenCalledTimes(1);
    expect(mockStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { status: 'READY', ratchetState: 'CI_RUNNING', isWorking: true },
      'event:workspace_state_changed+event:ratchet_state_changed+event:workspace_active',
      expect.any(Number)
    );
  });

  it('produces separate upserts for different workspaces', () => {
    const coalescer = new EventCoalescer(mockStore, 150);

    coalescer.enqueue('ws-1', { status: 'READY' as const }, 'event:workspace_state_changed');
    coalescer.enqueue('ws-2', { isWorking: true }, 'event:workspace_active');

    vi.advanceTimersByTime(150);

    expect(mockStore.upsert).toHaveBeenCalledTimes(2);
    expect(mockStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { status: 'READY' },
      'event:workspace_state_changed',
      expect.any(Number)
    );
    expect(mockStore.upsert).toHaveBeenCalledWith(
      'ws-2',
      { isWorking: true },
      'event:workspace_active',
      expect.any(Number)
    );
  });

  it('skips upsert for unknown workspace without projectId', () => {
    mockStore.getByWorkspaceId.mockReturnValue(undefined);
    const coalescer = new EventCoalescer(mockStore, 150);

    coalescer.enqueue('ws-unknown', { status: 'READY' as const }, 'event:workspace_state_changed');

    vi.advanceTimersByTime(150);

    expect(mockStore.upsert).not.toHaveBeenCalled();
  });

  it('upserts for known workspace even without projectId in fields', () => {
    mockStore.getByWorkspaceId.mockReturnValue({ projectId: 'proj-1' });
    const coalescer = new EventCoalescer(mockStore, 150);

    coalescer.enqueue('ws-1', { status: 'READY' as const }, 'event:workspace_state_changed');

    vi.advanceTimersByTime(150);

    expect(mockStore.upsert).toHaveBeenCalledTimes(1);
    expect(mockStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { status: 'READY' },
      'event:workspace_state_changed',
      expect.any(Number)
    );
  });

  it('flushAll() flushes all pending updates immediately', () => {
    const coalescer = new EventCoalescer(mockStore, 150);

    coalescer.enqueue('ws-1', { status: 'READY' as const }, 'event:workspace_state_changed');
    coalescer.enqueue('ws-2', { isWorking: true }, 'event:workspace_active');

    expect(coalescer.pendingCount).toBe(2);

    coalescer.flushAll();

    expect(mockStore.upsert).toHaveBeenCalledTimes(2);
    expect(coalescer.pendingCount).toBe(0);
  });

  it('joins coalesced source strings with +', () => {
    const coalescer = new EventCoalescer(mockStore, 150);

    coalescer.enqueue('ws-1', { status: 'READY' as const }, 'event:workspace_state_changed');
    coalescer.enqueue('ws-1', { ratchetState: 'IDLE' as const }, 'event:ratchet_state_changed');

    vi.advanceTimersByTime(150);

    expect(mockStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      expect.any(Object),
      'event:workspace_state_changed+event:ratchet_state_changed',
      expect.any(Number)
    );
  });

  it('tracks pendingCount correctly', () => {
    const coalescer = new EventCoalescer(mockStore, 150);

    expect(coalescer.pendingCount).toBe(0);

    coalescer.enqueue('ws-1', { status: 'READY' as const }, 'event:workspace_state_changed');
    expect(coalescer.pendingCount).toBe(1);

    coalescer.enqueue('ws-2', { isWorking: true }, 'event:workspace_active');
    expect(coalescer.pendingCount).toBe(2);

    // Another event for ws-1 does not increase count
    coalescer.enqueue('ws-1', { ratchetState: 'IDLE' as const }, 'event:ratchet_state_changed');
    expect(coalescer.pendingCount).toBe(2);

    vi.advanceTimersByTime(150);
    expect(coalescer.pendingCount).toBe(0);
  });

  it('flushAll skips unknown workspaces without projectId', () => {
    mockStore.getByWorkspaceId.mockReturnValue(undefined);
    const coalescer = new EventCoalescer(mockStore, 150);

    coalescer.enqueue('ws-unknown', { status: 'READY' as const }, 'event:workspace_state_changed');

    coalescer.flushAll();

    expect(mockStore.upsert).not.toHaveBeenCalled();
    expect(coalescer.pendingCount).toBe(0);
  });

  it('flushes immediately when enqueue is called with immediate option', () => {
    const coalescer = new EventCoalescer(mockStore, 150);

    coalescer.enqueue('ws-1', { isWorking: true }, 'event:workspace_active', {
      immediate: true,
    });

    expect(mockStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { isWorking: true },
      'event:workspace_active',
      expect.any(Number)
    );
    expect(coalescer.pendingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Event-to-field mapping tests
// ---------------------------------------------------------------------------

describe('Event-to-field mapping', () => {
  let mockStore: MockStore;

  beforeEach(() => {
    vi.useFakeTimers();
    mockStore = createMockStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps workspace state change to { status }', () => {
    const coalescer = new EventCoalescer(mockStore, 150);
    coalescer.enqueue('ws-1', { status: 'READY' as const }, 'event:workspace_state_changed');
    vi.advanceTimersByTime(150);

    expect(mockStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { status: 'READY' },
      'event:workspace_state_changed',
      expect.any(Number)
    );
  });

  it('maps PR snapshot to { prNumber, prState, prCiStatus } without prReviewState', () => {
    const coalescer = new EventCoalescer(mockStore, 150);
    coalescer.enqueue(
      'ws-1',
      { prNumber: 42, prState: 'OPEN' as const, prCiStatus: 'SUCCESS' as const },
      'event:pr_snapshot_updated'
    );
    vi.advanceTimersByTime(150);

    const upsertCall = mockStore.upsert.mock.calls[0]!;
    const fields = upsertCall[1];

    expect(fields).toEqual({ prNumber: 42, prState: 'OPEN', prCiStatus: 'SUCCESS' });
    expect(fields).not.toHaveProperty('prReviewState');
  });

  it('maps ratchet state change to { ratchetState }', () => {
    const coalescer = new EventCoalescer(mockStore, 150);
    coalescer.enqueue(
      'ws-1',
      { ratchetState: 'CI_RUNNING' as const },
      'event:ratchet_state_changed'
    );
    vi.advanceTimersByTime(150);

    expect(mockStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { ratchetState: 'CI_RUNNING' },
      'event:ratchet_state_changed',
      expect.any(Number)
    );
  });

  it('maps ratchet toggle change to { ratchetEnabled, ratchetState }', () => {
    const coalescer = new EventCoalescer(mockStore, 150);
    coalescer.enqueue(
      'ws-1',
      { ratchetEnabled: true, ratchetState: 'CI_RUNNING' as const },
      'event:ratchet_toggled'
    );
    vi.advanceTimersByTime(150);

    expect(mockStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { ratchetEnabled: true, ratchetState: 'CI_RUNNING' },
      'event:ratchet_toggled',
      expect.any(Number)
    );
  });

  it('maps run-script status change to { runScriptStatus }', () => {
    const coalescer = new EventCoalescer(mockStore, 150);
    coalescer.enqueue(
      'ws-1',
      { runScriptStatus: 'RUNNING' as const },
      'event:run_script_status_changed'
    );
    vi.advanceTimersByTime(150);

    expect(mockStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { runScriptStatus: 'RUNNING' },
      'event:run_script_status_changed',
      expect.any(Number)
    );
  });

  it('maps workspace_active to { isWorking: true }', () => {
    const coalescer = new EventCoalescer(mockStore, 150);
    coalescer.enqueue('ws-1', { isWorking: true }, 'event:workspace_active');
    vi.advanceTimersByTime(150);

    expect(mockStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { isWorking: true },
      'event:workspace_active',
      expect.any(Number)
    );
  });

  it('maps workspace_idle to { isWorking: false }', () => {
    const coalescer = new EventCoalescer(mockStore, 150);
    coalescer.enqueue('ws-1', { isWorking: false }, 'event:workspace_idle');
    vi.advanceTimersByTime(150);

    expect(mockStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { isWorking: false },
      'event:workspace_idle',
      expect.any(Number)
    );
  });
});

// ---------------------------------------------------------------------------
// Integration-style tests: configureEventCollector wiring
// ---------------------------------------------------------------------------

describe('configureEventCollector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    stopEventCollector();
  });

  it('registers 12 event listeners on domain singletons', () => {
    configureEventCollector();

    // workspaceStateMachine: 1 listener (WORKSPACE_STATE_CHANGED)
    expect(workspaceStateMachine.on).toHaveBeenCalledWith(
      'workspace_state_changed',
      expect.any(Function)
    );

    // prSnapshotService: snapshot updates and dispatch invalidations
    expect(prSnapshotService.on).toHaveBeenCalledWith('pr_snapshot_updated', expect.any(Function));
    expect(prSnapshotService.on).toHaveBeenCalledWith(
      'pr_dispatch_invalidated',
      expect.any(Function)
    );

    // ratchetService: 3 listeners (state, toggle, and dispatch changes)
    expect(ratchetService.on).toHaveBeenCalledWith('ratchet_state_changed', expect.any(Function));
    expect(ratchetService.on).toHaveBeenCalledWith('ratchet_toggled', expect.any(Function));
    expect(ratchetService.on).toHaveBeenCalledWith(
      'ratchet_dispatch_changed',
      expect.any(Function)
    );

    // runScriptStateMachine: 1 listener (RUN_SCRIPT_STATUS_CHANGED)
    expect(runScriptStateMachine.on).toHaveBeenCalledWith(
      'run_script_status_changed',
      expect.any(Function)
    );

    // workspaceActivityService: 3 listeners (workspace_active, workspace_idle, session_activity_changed)
    expect(workspaceActivityService.on).toHaveBeenCalledWith(
      'workspace_active',
      expect.any(Function)
    );
    expect(workspaceActivityService.on).toHaveBeenCalledWith(
      'workspace_idle',
      expect.any(Function)
    );
    expect(workspaceActivityService.on).toHaveBeenCalledWith(
      'session_activity_changed',
      expect.any(Function)
    );

    // sessionDomainService: 2 listeners (pending_request_changed, runtime_changed)
    expect(sessionDomainService.on).toHaveBeenCalledWith(
      'pending_request_changed',
      expect.any(Function)
    );
    expect(sessionDomainService.on).toHaveBeenCalledWith('runtime_changed', expect.any(Function));
  });

  it('removes sessionDomain listeners on stop', () => {
    configureEventCollector();

    stopEventCollector();

    expect(sessionDomainService.off).toHaveBeenCalledWith(
      'pending_request_changed',
      expect.any(Function)
    );
    expect(sessionDomainService.off).toHaveBeenCalledWith('runtime_changed', expect.any(Function));
  });

  it('removes every domain listener on stop', () => {
    configureEventCollector();

    stopEventCollector();

    for (const [event, handler] of vi.mocked(workspaceStateMachine.on).mock.calls) {
      expect(workspaceStateMachine.off).toHaveBeenCalledWith(event, handler);
    }
    for (const [event, handler] of vi.mocked(prSnapshotService.on).mock.calls) {
      expect(prSnapshotService.off).toHaveBeenCalledWith(event, handler);
    }
    for (const [event, handler] of vi.mocked(ratchetService.on).mock.calls) {
      expect(ratchetService.off).toHaveBeenCalledWith(event, handler);
    }
    for (const [event, handler] of vi.mocked(runScriptStateMachine.on).mock.calls) {
      expect(runScriptStateMachine.off).toHaveBeenCalledWith(event, handler);
    }
    for (const [event, handler] of vi.mocked(workspaceActivityService.on).mock.calls) {
      expect(workspaceActivityService.off).toHaveBeenCalledWith(event, handler);
    }
  });

  it('detaches and replaces the dispatch listener across configure-stop-configure', () => {
    configureEventCollector();
    const firstHandler = vi
      .mocked(ratchetService.on)
      .mock.calls.find((call) => call[0] === 'ratchet_dispatch_changed')![1];

    stopEventCollector();
    configureEventCollector();

    expect(ratchetService.off).toHaveBeenCalledWith('ratchet_dispatch_changed', firstHandler);
    const dispatchRegistrations = vi
      .mocked(ratchetService.on)
      .mock.calls.filter((call) => call[0] === 'ratchet_dispatch_changed');
    expect(dispatchRegistrations).toHaveLength(2);
    expect(dispatchRegistrations[1]![1]).not.toBe(firstHandler);
  });

  it('detaches the prior dispatch listener on direct reconfigure', () => {
    configureEventCollector();
    const firstHandler = vi
      .mocked(ratchetService.on)
      .mock.calls.find((call) => call[0] === 'ratchet_dispatch_changed')![1];

    configureEventCollector();

    expect(ratchetService.off).toHaveBeenCalledWith('ratchet_dispatch_changed', firstHandler);
  });

  it('detaches the dispatch listener on stop', () => {
    configureEventCollector();
    const handler = vi
      .mocked(ratchetService.on)
      .mock.calls.find((call) => call[0] === 'ratchet_dispatch_changed')![1];

    stopEventCollector();

    expect(ratchetService.off).toHaveBeenCalledWith('ratchet_dispatch_changed', handler);
  });

  it('ARCHIVED workspace event removes snapshot and cleans up workspace resources immediately', async () => {
    configureEventCollector();

    // Get the workspace state changed handler
    const onCall = vi
      .mocked(workspaceStateMachine.on)
      .mock.calls.find((call) => call[0] === 'workspace_state_changed');
    const handler = onCall![1] as (event: {
      workspaceId: string;
      fromStatus: string;
      toStatus: string;
    }) => void;

    handler({ workspaceId: 'ws-archived', fromStatus: 'READY', toStatus: 'ARCHIVED' });
    await Promise.resolve();

    // store.remove() called immediately, not through coalescer
    expect(workspaceSnapshotStore.remove).toHaveBeenCalledWith('ws-archived');
    expect(workspaceActivityService.clearWorkspace).toHaveBeenCalledWith('ws-archived');
    expect(sessionService.stopWorkspaceSessions).toHaveBeenCalledWith('ws-archived');
    expect(terminalService.destroyWorkspaceTerminals).toHaveBeenCalledWith('ws-archived');
    expect(workspaceSnapshotStore.upsert).not.toHaveBeenCalled();
  });

  it('non-ARCHIVED workspace event is applied immediately', () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);

    configureEventCollector();

    const onCall = vi
      .mocked(workspaceStateMachine.on)
      .mock.calls.find((call) => call[0] === 'workspace_state_changed');
    const handler = onCall![1] as (event: {
      workspaceId: string;
      fromStatus: string;
      toStatus: string;
      workspace: {
        projectId: string;
        name: string;
        branchName: string | null;
        createdAt: Date;
      };
    }) => void;

    handler({
      workspaceId: 'ws-1',
      fromStatus: 'NEW',
      toStatus: 'READY',
      workspace: {
        projectId: 'proj-1',
        name: 'ws',
        branchName: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });

    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledTimes(1);
    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ status: 'READY' }),
      'event:workspace_state_changed',
      expect.any(Number)
    );
  });

  it('workspace event with re-read row includes co-updated snapshot fields in the upsert', () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);

    configureEventCollector();

    const onCall = vi
      .mocked(workspaceStateMachine.on)
      .mock.calls.find((call) => call[0] === 'workspace_state_changed');
    const handler = onCall![1] as (event: {
      workspaceId: string;
      fromStatus: string;
      toStatus: string;
      workspace: {
        projectId: string;
        name: string;
        branchName: string | null;
        createdAt: Date;
      } | null;
    }) => void;

    handler({
      workspaceId: 'ws-1',
      fromStatus: 'PROVISIONING',
      toStatus: 'READY',
      workspace: {
        projectId: 'proj-1',
        name: 'My workspace',
        branchName: 'feature/test',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });

    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      {
        status: 'READY',
        projectId: 'proj-1',
        name: 'My workspace',
        branchName: 'feature/test',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      'event:workspace_state_changed',
      expect.any(Number)
    );
  });

  it('workspace event with re-read row seeds a workspace unknown to the store', () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue(undefined);

    configureEventCollector();

    const onCall = vi
      .mocked(workspaceStateMachine.on)
      .mock.calls.find((call) => call[0] === 'workspace_state_changed');
    const handler = onCall![1] as (event: {
      workspaceId: string;
      fromStatus: string;
      toStatus: string;
      workspace: {
        projectId: string;
        name: string;
        branchName: string | null;
        createdAt: Date;
      } | null;
    }) => void;

    handler({
      workspaceId: 'ws-new',
      fromStatus: 'NEW',
      toStatus: 'PROVISIONING',
      workspace: {
        projectId: 'proj-1',
        name: 'Fresh workspace',
        branchName: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });

    // projectId from the row lets the coalescer seed the entry instead of
    // skipping the upsert while waiting for reconciliation.
    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
      'ws-new',
      expect.objectContaining({ status: 'PROVISIONING', projectId: 'proj-1' }),
      'event:workspace_state_changed',
      expect.any(Number)
    );
  });

  it('ratchet_state_changed projects state authoritatively', async () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);
    vi.mocked(workspaceAccessor.findRawById).mockResolvedValue({
      ratchetEnabled: true,
      ratchetState: 'MERGED',
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
    } as never);
    configureEventCollector();

    const onCall = vi
      .mocked(ratchetService.on)
      .mock.calls.find((call) => call[0] === 'ratchet_state_changed');
    const handler = onCall![1] as (event: {
      workspaceId: string;
      fromState: string;
      toState: string;
    }) => void;

    handler({
      workspaceId: 'ws-1',
      fromState: 'READY',
      toState: 'MERGED',
    });

    await vi.waitFor(() =>
      expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({ ratchetState: 'MERGED' }),
        'projection:ratchet_authoritative',
        expect.any(Number)
      )
    );
    expect(kanbanStateService.updateCachedKanbanColumn).toHaveBeenCalledWith('ws-1');
  });

  it('ratchet_dispatch_changed publishes authoritative ownership and refreshes the cache', async () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);
    vi.mocked(workspaceAccessor.findRawById).mockResolvedValue({
      ratchetEnabled: true,
      ratchetState: 'CI_FAILED',
      ratchetDispatchOutcome: 'DIED',
      ratchetDispatchRetryCount: SERVICE_THRESHOLDS.ratchetDispatchMaxRetries,
    } as never);
    configureEventCollector();

    const onCall = vi
      .mocked(ratchetService.on)
      .mock.calls.find((call) => call[0] === 'ratchet_dispatch_changed');
    const handler = onCall![1] as (event: {
      workspaceId: string;
      outcome: string;
      retryCount: number;
    }) => void;

    handler({
      workspaceId: 'ws-1',
      outcome: 'DIED',
      retryCount: SERVICE_THRESHOLDS.ratchetDispatchMaxRetries,
    });

    await vi.waitFor(() =>
      expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({
          ratchetDispatchOutcome: 'DIED',
          ratchetDispatchRetryCount: SERVICE_THRESHOLDS.ratchetDispatchMaxRetries,
        }),
        'projection:ratchet_authoritative',
        expect.any(Number)
      )
    );
    expect(kanbanStateService.updateCachedKanbanColumn).toHaveBeenCalledWith('ws-1');
  });

  it('warns when a Ratchet-triggered cache refresh rejects', async () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);
    vi.mocked(kanbanStateService.updateCachedKanbanColumn).mockRejectedValueOnce(
      new Error('cache failed')
    );
    configureEventCollector();
    const handler = vi
      .mocked(ratchetService.on)
      .mock.calls.find((call) => call[0] === 'ratchet_dispatch_changed')![1] as (event: {
      workspaceId: string;
      outcome: 'DIED';
      retryCount: number;
    }) => void;

    handler({ workspaceId: 'ws-cache-failure', outcome: 'DIED', retryCount: 3 });
    await Promise.resolve();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Failed to refresh cached kanban column after Ratchet change',
      { workspaceId: 'ws-cache-failure', error: 'cache failed' }
    );
  });

  it('pr_snapshot_updated without prUrl does not overwrite existing prUrl in store', () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);

    configureEventCollector();

    const onCall = vi
      .mocked(prSnapshotService.on)
      .mock.calls.find((call) => call[0] === 'pr_snapshot_updated');
    const handler = onCall![1] as (event: {
      workspaceId: string;
      prNumber: number;
      prState: string;
      prCiStatus: string;
      prReviewState: string | null;
      prUrl?: string | null;
    }) => void;

    handler({
      workspaceId: 'ws-1',
      prNumber: 42,
      prState: 'OPEN',
      prCiStatus: 'SUCCESS',
      prReviewState: null,
    });

    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      {
        prNumber: 42,
        prState: 'OPEN',
        prCiStatus: 'SUCCESS',
      },
      'event:pr_snapshot_updated',
      expect.any(Number)
    );
  });

  it('pr_snapshot_updated authoritatively clears exhausted ownership after an aggregate change', async () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);
    vi.mocked(workspaceAccessor.findRawById).mockResolvedValue({
      ratchetEnabled: true,
      ratchetState: 'CI_FAILED',
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
    } as never);
    configureEventCollector();

    const handler = vi
      .mocked(prSnapshotService.on)
      .mock.calls.find((call) => call[0] === 'pr_snapshot_updated')![1] as (event: {
      workspaceId: string;
      prNumber: number;
      prState: string;
      prCiStatus: string;
      prReviewState: string | null;
      ratchetDispatchChanged: true;
    }) => void;

    handler({
      workspaceId: 'ws-exhausted',
      prNumber: 42,
      prState: 'OPEN',
      prCiStatus: 'PENDING',
      prReviewState: null,
      ratchetDispatchChanged: true,
    });

    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
      'ws-exhausted',
      { prNumber: 42, prState: 'OPEN', prCiStatus: 'PENDING' },
      'event:pr_snapshot_updated',
      expect.any(Number)
    );
    await vi.waitFor(() =>
      expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
        'ws-exhausted',
        expect.objectContaining({
          ratchetDispatchOutcome: null,
          ratchetDispatchRetryCount: 0,
        }),
        'projection:ratchet_authoritative',
        expect.any(Number)
      )
    );
  });

  it('projects direct CI ownership invalidations authoritatively', async () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);
    vi.mocked(workspaceAccessor.findRawById).mockResolvedValue({
      ratchetEnabled: true,
      ratchetState: 'CI_RUNNING',
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
    } as never);
    configureEventCollector();
    const handler = vi
      .mocked(prSnapshotService.on)
      .mock.calls.find((call) => call[0] === 'pr_dispatch_invalidated')![1] as (event: {
      workspaceId: string;
    }) => void;

    handler({ workspaceId: 'ws-direct-ci' });

    await vi.waitFor(() =>
      expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
        'ws-direct-ci',
        expect.objectContaining({
          ratchetState: 'CI_RUNNING',
          ratchetDispatchOutcome: null,
          ratchetDispatchRetryCount: 0,
        }),
        'projection:ratchet_authoritative',
        expect.any(Number)
      )
    );
    expect(kanbanStateService.updateCachedKanbanColumn).toHaveBeenCalledWith('ws-direct-ci');
  });

  it('keeps a newer dispatch when an older PR-reset callback arrives later', async () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);
    const firstRead = deferred<never>();
    vi.mocked(workspaceAccessor.findRawById)
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValue({
        ratchetEnabled: true,
        ratchetState: 'CI_FAILED',
        ratchetDispatchOutcome: 'RUNNING',
        ratchetDispatchRetryCount: 1,
      } as never);
    configureEventCollector();

    const dispatchHandler = vi
      .mocked(ratchetService.on)
      .mock.calls.find((call) => call[0] === 'ratchet_dispatch_changed')![1] as (
      event: Record<string, unknown>
    ) => void;
    const prHandler = vi
      .mocked(prSnapshotService.on)
      .mock.calls.find((call) => call[0] === 'pr_snapshot_updated')![1] as (
      event: Record<string, unknown>
    ) => void;

    dispatchHandler({ workspaceId: 'ws-race' });
    prHandler({
      workspaceId: 'ws-race',
      prNumber: 42,
      prState: 'OPEN',
      prCiStatus: 'FAILURE',
      prReviewState: null,
      ratchetDispatchChanged: true,
    });
    firstRead.resolve({
      ratchetEnabled: true,
      ratchetState: 'CI_FAILED',
      ratchetDispatchOutcome: 'RUNNING',
      ratchetDispatchRetryCount: 1,
    } as never);

    await vi.waitFor(() => expect(workspaceAccessor.findRawById).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(workspaceSnapshotStore.upsert).toHaveBeenLastCalledWith(
        'ws-race',
        expect.objectContaining({
          ratchetDispatchOutcome: 'RUNNING',
          ratchetDispatchRetryCount: 1,
        }),
        'projection:ratchet_authoritative',
        expect.any(Number)
      )
    );
  });

  it('keeps a newer PR reset when an older settlement callback arrives later', async () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);
    const firstRead = deferred<never>();
    vi.mocked(workspaceAccessor.findRawById)
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValue({
        ratchetEnabled: true,
        ratchetState: 'CI_FAILED',
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
      } as never);
    configureEventCollector();

    const dispatchHandler = vi
      .mocked(ratchetService.on)
      .mock.calls.find((call) => call[0] === 'ratchet_dispatch_changed')![1] as (
      event: Record<string, unknown>
    ) => void;
    const prHandler = vi
      .mocked(prSnapshotService.on)
      .mock.calls.find((call) => call[0] === 'pr_snapshot_updated')![1] as (
      event: Record<string, unknown>
    ) => void;

    prHandler({
      workspaceId: 'ws-race',
      prNumber: 42,
      prState: 'OPEN',
      prCiStatus: 'PENDING',
      prReviewState: null,
      ratchetDispatchChanged: true,
    });
    dispatchHandler({ workspaceId: 'ws-race' });
    firstRead.resolve({
      ratchetEnabled: true,
      ratchetState: 'CI_FAILED',
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
    } as never);

    await vi.waitFor(() => expect(workspaceAccessor.findRawById).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(workspaceSnapshotStore.upsert).toHaveBeenLastCalledWith(
        'ws-race',
        expect.objectContaining({
          ratchetDispatchOutcome: null,
          ratchetDispatchRetryCount: 0,
        }),
        'projection:ratchet_authoritative',
        expect.any(Number)
      )
    );
  });

  it('keeps a newer PR reset when an older enable callback arrives later', async () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);
    const firstRead = deferred<never>();
    vi.mocked(workspaceAccessor.findRawById)
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValue({
        ratchetEnabled: true,
        ratchetState: 'CI_FAILED',
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
      } as never);
    configureEventCollector();

    const toggleHandler = vi
      .mocked(ratchetService.on)
      .mock.calls.find((call) => call[0] === 'ratchet_toggled')![1] as (
      event: Record<string, unknown>
    ) => void;
    const prHandler = vi
      .mocked(prSnapshotService.on)
      .mock.calls.find((call) => call[0] === 'pr_snapshot_updated')![1] as (
      event: Record<string, unknown>
    ) => void;

    prHandler({
      workspaceId: 'ws-race',
      prNumber: 42,
      prState: 'OPEN',
      prCiStatus: 'PENDING',
      prReviewState: null,
      ratchetDispatchChanged: true,
    });
    toggleHandler({
      workspaceId: 'ws-race',
      enabled: true,
      ratchetState: 'CI_FAILED',
    });
    firstRead.resolve({
      ratchetEnabled: true,
      ratchetState: 'CI_FAILED',
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
    } as never);

    await vi.waitFor(() => expect(workspaceAccessor.findRawById).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(workspaceSnapshotStore.upsert).toHaveBeenLastCalledWith(
        'ws-race',
        expect.objectContaining({
          ratchetEnabled: true,
          ratchetDispatchOutcome: null,
          ratchetDispatchRetryCount: 0,
        }),
        'projection:ratchet_authoritative',
        expect.any(Number)
      )
    );
  });

  it('keeps a newer disable when an older ratchet-state callback arrives later', async () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);
    const firstRead = deferred<never>();
    vi.mocked(workspaceAccessor.findRawById)
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValue({
        ratchetEnabled: false,
        ratchetState: 'IDLE',
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
      } as never);
    configureEventCollector();
    const toggleHandler = vi
      .mocked(ratchetService.on)
      .mock.calls.find((call) => call[0] === 'ratchet_toggled')![1] as (
      event: Record<string, unknown>
    ) => void;
    const stateHandler = vi
      .mocked(ratchetService.on)
      .mock.calls.find((call) => call[0] === 'ratchet_state_changed')![1] as (
      event: Record<string, unknown>
    ) => void;

    toggleHandler({ workspaceId: 'ws-state-race', enabled: false, ratchetState: 'IDLE' });
    stateHandler({
      workspaceId: 'ws-state-race',
      fromState: 'CI_RUNNING',
      toState: 'CI_FAILED',
      prCiStatus: 'FAILURE',
    });
    firstRead.resolve({
      ratchetEnabled: false,
      ratchetState: 'IDLE',
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
    } as never);

    await vi.waitFor(() => expect(workspaceAccessor.findRawById).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(workspaceSnapshotStore.upsert).toHaveBeenLastCalledWith(
        'ws-state-race',
        expect.objectContaining({ ratchetState: 'IDLE' }),
        'projection:ratchet_authoritative',
        expect.any(Number)
      )
    );
    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
      'ws-state-race',
      { prCiStatus: 'FAILURE' },
      'event:ratchet_state_changed',
      expect.any(Number)
    );
  });

  it('retries a failed authoritative projection without another invalidation', async () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);
    vi.mocked(workspaceAccessor.findRawById)
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue({
        ratchetEnabled: true,
        ratchetState: 'CI_FAILED',
        ratchetDispatchOutcome: 'DIED',
        ratchetDispatchRetryCount: 3,
      } as never);
    configureEventCollector();
    const dispatchHandler = vi
      .mocked(ratchetService.on)
      .mock.calls.find((call) => call[0] === 'ratchet_dispatch_changed')![1] as (event: {
      workspaceId: string;
    }) => void;

    dispatchHandler({ workspaceId: 'ws-retry' });
    await vi.waitFor(() => expect(workspaceAccessor.findRawById).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(50);

    await vi.waitFor(() => expect(workspaceAccessor.findRawById).toHaveBeenCalledTimes(2));
    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
      'ws-retry',
      expect.objectContaining({ ratchetDispatchOutcome: 'DIED' }),
      'projection:ratchet_authoritative',
      expect.any(Number)
    );
  });

  it('cancels an authoritative projection retry when stopped', async () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);
    vi.mocked(workspaceAccessor.findRawById).mockRejectedValue(new Error('read failed'));
    configureEventCollector();
    const dispatchHandler = vi
      .mocked(ratchetService.on)
      .mock.calls.find((call) => call[0] === 'ratchet_dispatch_changed')![1] as (event: {
      workspaceId: string;
    }) => void;

    dispatchHandler({ workspaceId: 'ws-stop-retry' });
    await vi.waitFor(() => expect(workspaceAccessor.findRawById).toHaveBeenCalledTimes(1));
    stopEventCollector();
    await vi.advanceTimersByTimeAsync(100);

    expect(workspaceAccessor.findRawById).toHaveBeenCalledTimes(1);
  });

  it('triggers immediate ratchet recompute when PR identity changes', () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
      prNumber: 41,
      prUrl: 'https://github.com/org/repo/pull/41',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);

    configureEventCollector();

    const onCall = vi
      .mocked(prSnapshotService.on)
      .mock.calls.find((call) => call[0] === 'pr_snapshot_updated');
    const handler = onCall![1] as (event: {
      workspaceId: string;
      prNumber: number;
      prState: string;
      prCiStatus: string;
      prReviewState: string | null;
      prUrl?: string | null;
    }) => void;

    handler({
      workspaceId: 'ws-1',
      prNumber: 42,
      prState: 'OPEN',
      prCiStatus: 'PENDING',
      prReviewState: null,
      prUrl: 'https://github.com/org/repo/pull/42',
    });

    expect(ratchetService.checkWorkspaceById).toHaveBeenCalledWith('ws-1', {
      bypassPrFetchCooldown: true,
    });
  });

  it.each([
    'OPEN',
    'APPROVED',
    'CHANGES_REQUESTED',
    'DRAFT',
  ])('triggers immediate ratchet recompute when a closed PR is reopened as %s', (reopenedState) => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
      prNumber: 42,
      prUrl: 'https://github.com/org/repo/pull/42',
      prState: 'CLOSED',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);

    configureEventCollector();

    const onCall = vi
      .mocked(prSnapshotService.on)
      .mock.calls.find((call) => call[0] === 'pr_snapshot_updated');
    const handler = onCall![1] as (event: {
      workspaceId: string;
      prNumber: number;
      prState: string;
      prCiStatus: string;
      prReviewState: string | null;
      prUrl?: string | null;
    }) => void;

    handler({
      workspaceId: 'ws-1',
      prNumber: 42,
      prState: reopenedState,
      prCiStatus: 'PENDING',
      prReviewState: null,
      prUrl: 'https://github.com/org/repo/pull/42',
    });

    expect(ratchetService.checkWorkspaceById).toHaveBeenCalledWith('ws-1', {
      bypassPrFetchCooldown: true,
    });
  });

  it('settles ratchet state without a recompute when PR is closed', () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
      prNumber: 42,
      prUrl: 'https://github.com/org/repo/pull/42',
      prState: 'OPEN',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);

    configureEventCollector();

    const onCall = vi
      .mocked(prSnapshotService.on)
      .mock.calls.find((call) => call[0] === 'pr_snapshot_updated');
    const handler = onCall![1] as (event: {
      workspaceId: string;
      prNumber: number;
      prState: string;
      prCiStatus: string;
      prReviewState: string | null;
      prUrl?: string | null;
    }) => void;

    handler({
      workspaceId: 'ws-1',
      prNumber: 42,
      prState: 'CLOSED',
      prCiStatus: 'UNKNOWN',
      prReviewState: null,
      prUrl: 'https://github.com/org/repo/pull/42',
    });

    expect(ratchetService.checkWorkspaceById).not.toHaveBeenCalled();
    expect(ratchetService.markPrClosed).toHaveBeenCalledWith('ws-1');
  });

  it('re-settles ratchet state when PR stays closed across syncs', () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
      prNumber: 42,
      prUrl: 'https://github.com/org/repo/pull/42',
      prState: 'CLOSED',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);

    configureEventCollector();

    const onCall = vi
      .mocked(prSnapshotService.on)
      .mock.calls.find((call) => call[0] === 'pr_snapshot_updated');
    const handler = onCall![1] as (event: {
      workspaceId: string;
      prNumber: number;
      prState: string;
      prCiStatus: string;
      prReviewState: string | null;
      prUrl?: string | null;
    }) => void;

    handler({
      workspaceId: 'ws-1',
      prNumber: 42,
      prState: 'CLOSED',
      prCiStatus: 'UNKNOWN',
      prReviewState: null,
      prUrl: 'https://github.com/org/repo/pull/42',
    });

    expect(ratchetService.checkWorkspaceById).not.toHaveBeenCalled();
    expect(ratchetService.markPrClosed).toHaveBeenCalledWith('ws-1');
  });

  it('still triggers ratchet recompute when store mutates snapshot during immediate upsert', () => {
    const existingSnapshot: { projectId: string; prNumber: number | null; prUrl: string | null } = {
      projectId: 'proj-1',
      prNumber: 41,
      prUrl: 'https://github.com/org/repo/pull/41',
    };
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue(
      existingSnapshot as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>
    );
    vi.mocked(workspaceSnapshotStore.upsert).mockImplementation((_, update) => {
      if (update.prNumber !== undefined) {
        existingSnapshot.prNumber = update.prNumber;
      }
      if (update.prUrl !== undefined) {
        existingSnapshot.prUrl = update.prUrl;
      }
    });

    configureEventCollector();

    const onCall = vi
      .mocked(prSnapshotService.on)
      .mock.calls.find((call) => call[0] === 'pr_snapshot_updated');
    const handler = onCall![1] as (event: {
      workspaceId: string;
      prNumber: number;
      prState: string;
      prCiStatus: string;
      prReviewState: string | null;
      prUrl?: string | null;
    }) => void;

    handler({
      workspaceId: 'ws-1',
      prNumber: 42,
      prState: 'OPEN',
      prCiStatus: 'PENDING',
      prReviewState: null,
      prUrl: 'https://github.com/org/repo/pull/42',
    });

    expect(ratchetService.checkWorkspaceById).toHaveBeenCalledWith('ws-1', {
      bypassPrFetchCooldown: true,
    });
  });

  it('does not trigger immediate ratchet recompute when PR identity is unchanged', () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
      prNumber: 42,
      prUrl: 'https://github.com/org/repo/pull/42',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);

    configureEventCollector();

    const onCall = vi
      .mocked(prSnapshotService.on)
      .mock.calls.find((call) => call[0] === 'pr_snapshot_updated');
    const handler = onCall![1] as (event: {
      workspaceId: string;
      prNumber: number;
      prState: string;
      prCiStatus: string;
      prReviewState: string | null;
      prUrl?: string | null;
    }) => void;

    handler({
      workspaceId: 'ws-1',
      prNumber: 42,
      prState: 'OPEN',
      prCiStatus: 'SUCCESS',
      prReviewState: null,
      prUrl: 'https://github.com/org/repo/pull/42',
    });

    expect(ratchetService.checkWorkspaceById).not.toHaveBeenCalled();
  });

  it('ratchet_toggled updates state immediately and projects authoritative ownership', async () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);
    vi.mocked(workspaceAccessor.findRawById).mockResolvedValue({
      ratchetEnabled: true,
      ratchetState: 'CI_RUNNING',
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
    } as never);
    configureEventCollector();

    const onCall = vi
      .mocked(ratchetService.on)
      .mock.calls.find((call) => call[0] === 'ratchet_toggled');
    const handler = onCall![1] as (event: {
      workspaceId: string;
      enabled: boolean;
      ratchetState: string;
    }) => void;

    handler({
      workspaceId: 'ws-1',
      enabled: true,
      ratchetState: 'CI_RUNNING',
    });

    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      {
        ratchetEnabled: true,
        ratchetState: 'CI_RUNNING',
      },
      'event:ratchet_toggled',
      expect.any(Number)
    );
    await vi.waitFor(() =>
      expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({
          ratchetDispatchOutcome: null,
          ratchetDispatchRetryCount: 0,
        }),
        'projection:ratchet_authoritative',
        expect.any(Number)
      )
    );
    expect(kanbanStateService.updateCachedKanbanColumn).toHaveBeenCalledWith('ws-1');
  });

  it('stopEventCollector flushes pending and clears coalescer', () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);

    configureEventCollector();

    // Trigger an event
    const onCall = vi
      .mocked(workspaceStateMachine.on)
      .mock.calls.find((call) => call[0] === 'workspace_state_changed');
    const handler = onCall![1] as (event: {
      workspaceId: string;
      fromStatus: string;
      toStatus: string;
      workspace: {
        projectId: string;
        name: string;
        branchName: string | null;
        createdAt: Date;
      };
    }) => void;

    handler({
      workspaceId: 'ws-1',
      fromStatus: 'NEW',
      toStatus: 'READY',
      workspace: {
        projectId: 'proj-1',
        name: 'ws',
        branchName: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });

    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledTimes(1);

    // Stop should no-op pending flush and still clear coalescer.
    stopEventCollector();

    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledTimes(1);
    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ status: 'READY' }),
      'event:workspace_state_changed',
      expect.any(Number)
    );
  });

  it('workspace_active enqueues immediate working state and does not refresh session summaries', () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);
    configureEventCollector();

    const onCall = vi
      .mocked(workspaceActivityService.on)
      .mock.calls.find((call) => call[0] === 'workspace_active');
    const handler = onCall![1] as (event: { workspaceId: string }) => void;

    handler({ workspaceId: 'ws-1' });

    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { isWorking: true, hasHadSessions: true },
      'event:workspace_active',
      expect.any(Number)
    );
    expect(sessionDataService.findAgentSessionsByWorkspaceId).not.toHaveBeenCalled();
  });

  it('workspace_idle enqueues immediate idle state and triggers throttled PR refresh', () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);
    configureEventCollector();

    const onCall = vi
      .mocked(workspaceActivityService.on)
      .mock.calls.find((call) => call[0] === 'workspace_idle');
    const handler = onCall![1] as (event: { workspaceId: string }) => void;

    handler({ workspaceId: 'ws-1' });

    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { isWorking: false, hasHadSessions: true },
      'event:workspace_idle',
      expect.any(Number)
    );
    expect(prSnapshotService.refreshWorkspace).toHaveBeenCalledWith('ws-1');
    expect(sessionDataService.findAgentSessionsByWorkspaceId).not.toHaveBeenCalled();
  });

  it('workspace active transition performs one session summary query', () => {
    configureEventCollector();

    const sessionActivityCall = vi
      .mocked(workspaceActivityService.on)
      .mock.calls.find((call) => call[0] === 'session_activity_changed');
    const sessionActivityHandler = sessionActivityCall![1] as (event: {
      workspaceId: string;
      sessionId: string;
      isWorking: boolean;
    }) => void;

    const activeCall = vi
      .mocked(workspaceActivityService.on)
      .mock.calls.find((call) => call[0] === 'workspace_active');
    const activeHandler = activeCall![1] as (event: { workspaceId: string }) => void;

    sessionActivityHandler({ workspaceId: 'ws-1', sessionId: 's-1', isWorking: true });
    activeHandler({ workspaceId: 'ws-1' });

    expect(sessionDataService.findAgentSessionsByWorkspaceId).toHaveBeenCalledTimes(1);
    expect(sessionDataService.findAgentSessionsByWorkspaceId).toHaveBeenCalledWith('ws-1');
  });

  it('session_activity_changed refreshes session summaries', async () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);
    vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId).mockResolvedValue([
      {
        id: 's-1',
        name: 'Chat 1',
        workflow: 'followup',
        model: 'claude-sonnet',
        status: 'IDLE',
      } as Awaited<ReturnType<typeof sessionDataService.findAgentSessionsByWorkspaceId>>[number],
    ]);

    configureEventCollector();

    const onCall = vi
      .mocked(workspaceActivityService.on)
      .mock.calls.find((call) => call[0] === 'session_activity_changed');
    const handler = onCall![1] as (event: {
      workspaceId: string;
      sessionId: string;
      isWorking: boolean;
    }) => void;

    handler({ workspaceId: 'ws-1', sessionId: 's-1', isWorking: true });
    await Promise.resolve();
    vi.advanceTimersByTime(150);

    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({
        hasHadSessions: true,
        sessionSummaries: expect.arrayContaining([
          expect.objectContaining({
            sessionId: 's-1',
          }),
        ]),
      }),
      expect.stringContaining('event:session_activity_changed'),
      expect.any(Number)
    );
  });

  it('runtime_changed refreshes session summaries for the session workspace', async () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);
    vi.mocked(sessionDataService.findAgentSessionById).mockResolvedValue({
      id: 's-1',
      workspaceId: 'ws-1',
    } as Awaited<ReturnType<typeof sessionDataService.findAgentSessionById>>);
    vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId).mockResolvedValue([
      {
        id: 's-1',
        name: 'Chat 1',
        workflow: 'followup',
        model: 'claude-sonnet',
        status: 'IDLE',
      } as Awaited<ReturnType<typeof sessionDataService.findAgentSessionsByWorkspaceId>>[number],
    ]);

    configureEventCollector();

    const onCall = vi
      .mocked(sessionDomainService.on)
      .mock.calls.find((call) => call[0] === 'runtime_changed');
    const handler = onCall![1] as (event: { sessionId: string }) => void;

    handler({ sessionId: 's-1' });
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(150);

    expect(sessionDataService.findAgentSessionById).toHaveBeenCalledWith('s-1');
    expect(sessionDataService.findAgentSessionsByWorkspaceId).toHaveBeenCalledWith('ws-1');
    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({
        sessionSummaries: expect.arrayContaining([
          expect.objectContaining({
            sessionId: 's-1',
          }),
        ]),
      }),
      expect.stringContaining('event:session_runtime_changed'),
      expect.any(Number)
    );
  });

  it('pending_request_changed refreshes pendingRequestType', async () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);
    vi.mocked(sessionDataService.findAgentSessionById).mockResolvedValue({
      id: 's-1',
      workspaceId: 'ws-1',
    } as Awaited<ReturnType<typeof sessionDataService.findAgentSessionById>>);
    vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId).mockResolvedValue([
      {
        id: 's-1',
        name: 'Chat 1',
        workflow: 'followup',
        model: 'claude-sonnet',
        status: 'IDLE',
      } as Awaited<ReturnType<typeof sessionDataService.findAgentSessionsByWorkspaceId>>[number],
    ]);
    vi.mocked(computePendingRequestType).mockReturnValue('permission_request');

    configureEventCollector();

    const onCall = vi
      .mocked(sessionDomainService.on)
      .mock.calls.find((call) => call[0] === 'pending_request_changed');
    const handler = onCall![1] as (event: {
      sessionId: string;
      requestId: string;
      hasPending: boolean;
    }) => void;

    handler({ sessionId: 's-1', requestId: 'req-1', hasPending: false });
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(150);

    expect(computePendingRequestType).toHaveBeenCalledWith(['s-1'], expect.any(Map));
    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { pendingRequestType: 'permission_request' },
      'event:pending_request_changed',
      expect.any(Number)
    );
    expect(chatEventForwarderService.getAllPendingRequests).toHaveBeenCalledTimes(1);
  });
});

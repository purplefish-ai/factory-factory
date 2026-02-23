import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnapshotUpdateInput } from '@/backend/services/workspace-snapshot-store.service';

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

vi.mock('@/backend/domains/workspace', () => ({
  WORKSPACE_STATE_CHANGED: 'workspace_state_changed',
  workspaceStateMachine: { on: vi.fn() },
  workspaceActivityService: { on: vi.fn() },
  computePendingRequestType: vi.fn().mockReturnValue(null),
}));

vi.mock('@/backend/domains/github', () => ({
  PR_SNAPSHOT_UPDATED: 'pr_snapshot_updated',
  prSnapshotService: {
    on: vi.fn(),
    refreshWorkspace: vi.fn().mockResolvedValue({ success: false, reason: 'no_pr_url' }),
  },
}));

vi.mock('@/backend/domains/ratchet', () => ({
  RATCHET_STATE_CHANGED: 'ratchet_state_changed',
  RATCHET_TOGGLED: 'ratchet_toggled',
  ratchetService: { on: vi.fn() },
}));

vi.mock('@/backend/domains/run-script', () => ({
  RUN_SCRIPT_STATUS_CHANGED: 'run_script_status_changed',
  runScriptStateMachine: { on: vi.fn() },
}));

vi.mock('@/backend/domains/session', () => ({
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
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { prSnapshotService } from '@/backend/domains/github';
import { ratchetService } from '@/backend/domains/ratchet';
import { runScriptStateMachine } from '@/backend/domains/run-script';
import {
  chatEventForwarderService,
  sessionDataService,
  sessionDomainService,
} from '@/backend/domains/session';
import {
  computePendingRequestType,
  workspaceActivityService,
  workspaceStateMachine,
} from '@/backend/domains/workspace';
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
      'event:workspace_state_changed'
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
      'event:workspace_state_changed+event:ratchet_state_changed+event:workspace_active'
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
      'event:workspace_state_changed'
    );
    expect(mockStore.upsert).toHaveBeenCalledWith(
      'ws-2',
      { isWorking: true },
      'event:workspace_active'
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
      'event:workspace_state_changed'
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
      'event:workspace_state_changed+event:ratchet_state_changed'
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
      'event:workspace_active'
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
      'event:workspace_state_changed'
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
      'event:ratchet_state_changed'
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
      'event:ratchet_toggled'
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
      'event:run_script_status_changed'
    );
  });

  it('maps workspace_active to { isWorking: true }', () => {
    const coalescer = new EventCoalescer(mockStore, 150);
    coalescer.enqueue('ws-1', { isWorking: true }, 'event:workspace_active');
    vi.advanceTimersByTime(150);

    expect(mockStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { isWorking: true },
      'event:workspace_active'
    );
  });

  it('maps workspace_idle to { isWorking: false }', () => {
    const coalescer = new EventCoalescer(mockStore, 150);
    coalescer.enqueue('ws-1', { isWorking: false }, 'event:workspace_idle');
    vi.advanceTimersByTime(150);

    expect(mockStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { isWorking: false },
      'event:workspace_idle'
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

  it('registers 10 event listeners on domain singletons', () => {
    configureEventCollector();

    // workspaceStateMachine: 1 listener (WORKSPACE_STATE_CHANGED)
    expect(workspaceStateMachine.on).toHaveBeenCalledWith(
      'workspace_state_changed',
      expect.any(Function)
    );

    // prSnapshotService: 1 listener (PR_SNAPSHOT_UPDATED)
    expect(prSnapshotService.on).toHaveBeenCalledWith('pr_snapshot_updated', expect.any(Function));

    // ratchetService: 2 listeners (RATCHET_STATE_CHANGED + RATCHET_TOGGLED)
    expect(ratchetService.on).toHaveBeenCalledWith('ratchet_state_changed', expect.any(Function));
    expect(ratchetService.on).toHaveBeenCalledWith('ratchet_toggled', expect.any(Function));

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

  it('ARCHIVED workspace event calls store.remove() immediately', () => {
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

    // store.remove() called immediately, not through coalescer
    expect(workspaceSnapshotStore.remove).toHaveBeenCalledWith('ws-archived');
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
    }) => void;

    handler({ workspaceId: 'ws-1', fromStatus: 'NEW', toStatus: 'READY' });

    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledTimes(1);
    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { status: 'READY' },
      'event:workspace_state_changed'
    );
  });

  it('ratchet_state_changed is applied immediately', () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);
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

    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { ratchetState: 'MERGED' },
      'event:ratchet_state_changed'
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
      'event:pr_snapshot_updated'
    );
  });

  it('ratchet_toggled updates ratchetEnabled and ratchetState immediately', () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);
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
      { ratchetEnabled: true, ratchetState: 'CI_RUNNING' },
      'event:ratchet_toggled'
    );
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
    }) => void;

    handler({
      workspaceId: 'ws-1',
      fromStatus: 'NEW',
      toStatus: 'READY',
    });

    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledTimes(1);

    // Stop should no-op pending flush and still clear coalescer.
    stopEventCollector();

    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledTimes(1);
    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { status: 'READY' },
      'event:workspace_state_changed'
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
      'event:workspace_active'
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
      'event:workspace_idle'
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
      expect.stringContaining('event:session_activity_changed')
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
      expect.stringContaining('event:session_runtime_changed')
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
      'event:pending_request_changed'
    );
    expect(chatEventForwarderService.getAllPendingRequests).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnapshotUpdateInput } from '@/backend/services';

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
}));

vi.mock('@/backend/domains/github', () => ({
  PR_SNAPSHOT_UPDATED: 'pr_snapshot_updated',
  prSnapshotService: { on: vi.fn() },
}));

vi.mock('@/backend/domains/ratchet', () => ({
  RATCHET_STATE_CHANGED: 'ratchet_state_changed',
  ratchetService: { on: vi.fn() },
}));

vi.mock('@/backend/domains/run-script', () => ({
  RUN_SCRIPT_STATUS_CHANGED: 'run_script_status_changed',
  runScriptStateMachine: { on: vi.fn() },
}));

vi.mock('@/backend/services', () => ({
  workspaceSnapshotStore: {
    upsert: vi.fn(),
    getByWorkspaceId: vi.fn(),
    remove: vi.fn(),
  },
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
import { workspaceActivityService, workspaceStateMachine } from '@/backend/domains/workspace';
import { workspaceSnapshotStore } from '@/backend/services';

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

  it('registers 6 event listeners on domain singletons', () => {
    configureEventCollector();

    // workspaceStateMachine: 1 listener (WORKSPACE_STATE_CHANGED)
    expect(workspaceStateMachine.on).toHaveBeenCalledWith(
      'workspace_state_changed',
      expect.any(Function)
    );

    // prSnapshotService: 1 listener (PR_SNAPSHOT_UPDATED)
    expect(prSnapshotService.on).toHaveBeenCalledWith('pr_snapshot_updated', expect.any(Function));

    // ratchetService: 1 listener (RATCHET_STATE_CHANGED)
    expect(ratchetService.on).toHaveBeenCalledWith('ratchet_state_changed', expect.any(Function));

    // runScriptStateMachine: 1 listener (RUN_SCRIPT_STATUS_CHANGED)
    expect(runScriptStateMachine.on).toHaveBeenCalledWith(
      'run_script_status_changed',
      expect.any(Function)
    );

    // workspaceActivityService: 2 listeners (workspace_active, workspace_idle)
    expect(workspaceActivityService.on).toHaveBeenCalledWith(
      'workspace_active',
      expect.any(Function)
    );
    expect(workspaceActivityService.on).toHaveBeenCalledWith(
      'workspace_idle',
      expect.any(Function)
    );
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

  it('non-ARCHIVED workspace event goes through coalescer', () => {
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

    // Not called yet -- coalescing
    expect(workspaceSnapshotStore.upsert).not.toHaveBeenCalled();

    vi.advanceTimersByTime(150);

    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledTimes(1);
  });

  it('stopEventCollector flushes pending and clears coalescer', () => {
    vi.mocked(workspaceSnapshotStore.getByWorkspaceId).mockReturnValue({
      projectId: 'proj-1',
    } as ReturnType<typeof workspaceSnapshotStore.getByWorkspaceId>);

    configureEventCollector();

    // Trigger an event
    const onCall = vi
      .mocked(workspaceActivityService.on)
      .mock.calls.find((call) => call[0] === 'workspace_active');
    const handler = onCall![1] as (event: { workspaceId: string }) => void;

    handler({ workspaceId: 'ws-1' });

    // Not flushed yet
    expect(workspaceSnapshotStore.upsert).not.toHaveBeenCalled();

    // Stop flushes all pending
    stopEventCollector();

    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledTimes(1);
    expect(workspaceSnapshotStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { isWorking: true },
      'event:workspace_active'
    );
  });
});

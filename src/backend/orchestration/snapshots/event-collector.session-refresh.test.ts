import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEventCollectorOrchestrator,
  type EventCollectorDependencies,
} from './event-collector.orchestrator';

vi.mock('@/backend/services/github', () => ({
  PR_SNAPSHOT_UPDATED: 'pr_snapshot_updated',
  PR_URL_ATTACHED: 'pr_url_attached',
  PR_DETACHED: 'pr_detached',
}));
vi.mock('@/backend/services/ratchet', () => ({
  RATCHET_DISPATCH_CHANGED: 'ratchet_dispatch_changed',
  RATCHET_STATE_CHANGED: 'ratchet_state_changed',
  RATCHET_TOGGLED: 'ratchet_toggled',
}));
vi.mock('@/backend/services/run-script', () => ({
  RUN_SCRIPT_STATUS_CHANGED: 'run_script_status_changed',
}));
vi.mock('@/backend/services/workspace', () => ({
  WORKSPACE_CREATED: 'workspace_created',
  WORKSPACE_STATE_CHANGED: 'workspace_state_changed',
}));

function createCollector() {
  const sessionDomainService = new EventEmitter();
  const findAgentSessionById = vi.fn().mockResolvedValue({ id: 's-1', workspaceId: 'ws-1' });
  const findAgentSessionsByWorkspaceId = vi.fn().mockResolvedValue([]);
  // Only session-driven refreshes are exercised by this fixture.
  const dependencies = {
    createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    chatEventForwarderService: { getAllPendingRequests: () => new Map() },
    computePendingRequestType: () => null,
    prSnapshotService: new EventEmitter(),
    workspaceActivityService: new EventEmitter(),
    workspaceStateMachine: new EventEmitter(),
    ratchetService: new EventEmitter(),
    runScriptStateMachine: new EventEmitter(),
    sessionDomainService,
    sessionDataService: { findAgentSessionById, findAgentSessionsByWorkspaceId },
    sessionLifecycleService: { getRuntimeSnapshot: vi.fn() },
    workspaceDataService: { subscribeAcceptedBranch: () => vi.fn() },
    workspaceSnapshotStore: {
      getAllWorkspaceIds: () => [],
      getByWorkspaceId: () => ({ projectId: 'project-1' }),
      upsert: vi.fn(),
    },
  } as unknown as EventCollectorDependencies;
  return {
    collector: createEventCollectorOrchestrator(dependencies),
    sessionDomainService,
    findAgentSessionById,
    findAgentSessionsByWorkspaceId,
  };
}

describe('event collector session refreshes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([
    ['runtime_changed', { sessionId: 's-1' }],
    ['pending_request_changed', { sessionId: 's-1', requestId: 'r-1', hasPending: true }],
  ])('collapses a burst of %s events into one query plus one rerun', async (event, payload) => {
    const {
      collector,
      sessionDomainService,
      findAgentSessionById,
      findAgentSessionsByWorkspaceId,
    } = createCollector();
    collector.start();

    // The first event resolves and caches the session's workspace.
    sessionDomainService.emit(event, payload);
    await vi.advanceTimersByTimeAsync(150);
    expect(findAgentSessionById).toHaveBeenCalledOnce();
    findAgentSessionById.mockClear();
    findAgentSessionsByWorkspaceId.mockClear();

    for (let index = 0; index < 10; index++) {
      sessionDomainService.emit(event, payload);
    }
    await vi.advanceTimersByTimeAsync(150);

    expect(findAgentSessionById).not.toHaveBeenCalled();
    expect(findAgentSessionsByWorkspaceId).toHaveBeenCalledTimes(2);
    collector.stop();
  });

  it('shares one session lookup between events that arrive before it resolves', async () => {
    const { collector, sessionDomainService, findAgentSessionById } = createCollector();
    collector.start();

    for (let index = 0; index < 5; index++) {
      sessionDomainService.emit('runtime_changed', { sessionId: 's-1' });
    }
    await vi.advanceTimersByTimeAsync(150);

    expect(findAgentSessionById).toHaveBeenCalledOnce();
    collector.stop();
  });

  it('does not cache a lookup that finishes after the collector restarts', async () => {
    const { collector, sessionDomainService, findAgentSessionById } = createCollector();
    let resolveLookup!: (value: { id: string; workspaceId: string }) => void;
    findAgentSessionById.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLookup = resolve;
      })
    );
    collector.start();
    sessionDomainService.emit('runtime_changed', { sessionId: 's-1' });
    collector.stop();
    collector.start();
    resolveLookup({ id: 's-1', workspaceId: 'ws-1' });
    await vi.advanceTimersByTimeAsync(150);

    sessionDomainService.emit('runtime_changed', { sessionId: 's-1' });
    await vi.advanceTimersByTimeAsync(150);

    // The stale lookup was not cached, so the restarted collector looks it up again.
    expect(findAgentSessionById).toHaveBeenCalledTimes(2);
    collector.stop();
  });

  it('forgets cached session workspaces when stopped', async () => {
    const { collector, sessionDomainService, findAgentSessionById } = createCollector();
    collector.start();
    sessionDomainService.emit('runtime_changed', { sessionId: 's-1' });
    await vi.advanceTimersByTimeAsync(150);
    collector.stop();

    collector.start();
    sessionDomainService.emit('runtime_changed', { sessionId: 's-1' });
    await vi.advanceTimersByTimeAsync(150);

    expect(findAgentSessionById).toHaveBeenCalledTimes(2);
    collector.stop();
  });
});

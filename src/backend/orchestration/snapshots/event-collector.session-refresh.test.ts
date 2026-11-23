import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '@/test-utils/deferred';
import {
  createEventCollectorOrchestrator,
  type EventCollectorDependencies,
} from './event-collector.orchestrator';

vi.mock('@/backend/services/github', () => ({
  PR_SNAPSHOT_UPDATED: 'pr_snapshot_updated',
  PR_URL_ATTACHED: 'pr_url_attached',
  PR_DETACHED: 'pr_detached',
}));
vi.mock('@/backend/orchestration/pull-requests/ratchet.service', () => ({
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
  const findWorkspaceIdForSession = vi.fn().mockResolvedValue('ws-1');
  const workspaceActivityService = Object.assign(new EventEmitter(), { clearWorkspace: vi.fn() });
  const getRuntimeSnapshot = vi.fn().mockReturnValue({
    phase: 'idle',
    processState: 'alive',
    activity: 'IDLE',
    updatedAt: '2026-11-20',
  });
  const upsert = vi.fn();
  const pendingRequests = new Map<string, { toolName: string; input: object }>();
  const findAgentSessionsByWorkspaceId = vi.fn().mockResolvedValue([]);
  // Only session-driven refreshes are exercised by this fixture.
  const dependencies = {
    createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    chatEventForwarderService: { getAllPendingRequests: () => pendingRequests },
    computePendingRequestType: () => null,
    prSnapshotService: new EventEmitter(),
    workspaceActivityService,
    prFetchCoordinator: { removeWorkspace: vi.fn() },
    workspaceStateMachine: new EventEmitter(),
    ratchetService: new EventEmitter(),
    runScriptStateMachine: new EventEmitter(),
    sessionDomainService,
    sessionDataService: { findWorkspaceIdForSession, findAgentSessionsByWorkspaceId },
    sessionLifecycleService: { getRuntimeSnapshot },
    workspaceDataService: { subscribeAcceptedBranch: () => vi.fn() },
    workspaceSnapshotStore: {
      getAllWorkspaceIds: () => [],
      getByWorkspaceId: () => ({ projectId: 'project-1' }),
      upsert,
      remove: vi.fn(),
    },
  } as unknown as EventCollectorDependencies;
  return {
    collector: createEventCollectorOrchestrator(dependencies),
    upsert,
    pendingRequests,
    getRuntimeSnapshot,
    workspaceActivityService,
    sessionDomainService,
    findWorkspaceIdForSession,
    findAgentSessionsByWorkspaceId,
  };
}

describe('event collector session refreshes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shares one durable read across a turn and publishes the latest live states at the first deadline', async () => {
    const {
      collector,
      sessionDomainService,
      workspaceActivityService,
      findWorkspaceIdForSession,
      findAgentSessionsByWorkspaceId,
      getRuntimeSnapshot,
      pendingRequests,
      upsert,
    } = createCollector();
    const first = { id: 's-1', name: 'First', workflow: null, model: 'model-a', status: 'RUNNING' };
    const removed = { ...first, id: 's-2' };
    findAgentSessionsByWorkspaceId.mockResolvedValue([first, removed]);
    getRuntimeSnapshot.mockReturnValue({
      phase: 'running',
      activity: 'WORKING',
      processState: 'alive',
    });
    collector.start();

    sessionDomainService.emit('runtime_changed', { sessionId: 's-1' });
    await vi.advanceTimersByTimeAsync(40);
    workspaceActivityService.emit('session_activity_changed', { workspaceId: 'ws-1' });
    await vi.advanceTimersByTimeAsync(40);
    pendingRequests.set('s-1', { toolName: 'Bash', input: {} });
    sessionDomainService.emit('pending_request_changed', { sessionId: 's-1', hasPending: true });
    await vi.advanceTimersByTimeAsync(70);

    expect(findWorkspaceIdForSession).toHaveBeenCalledExactlyOnceWith('s-1');
    expect(findAgentSessionsByWorkspaceId).toHaveBeenCalledExactlyOnceWith('ws-1');
    expect(upsert.mock.lastCall?.[1]).toMatchObject({
      isWorking: true,
      sessionSummaries: [
        { sessionId: 's-1', model: 'model-a', pendingRequestType: 'permission_request' },
        { sessionId: 's-2' },
      ],
    });

    const changed = { ...first, name: 'Renamed', model: 'model-b', status: 'IDLE' };
    findAgentSessionsByWorkspaceId.mockResolvedValue([changed, { ...first, id: 's-3' }]);
    pendingRequests.clear();
    getRuntimeSnapshot.mockReturnValue({ phase: 'idle', activity: 'IDLE', processState: 'alive' });
    sessionDomainService.emit('runtime_changed', { sessionId: 's-1' });
    await vi.advanceTimersByTimeAsync(150);

    expect(findAgentSessionsByWorkspaceId).toHaveBeenCalledTimes(2);
    expect(upsert.mock.lastCall?.[1]).toMatchObject({
      isWorking: false,
      sessionSummaries: [
        {
          sessionId: 's-1',
          name: 'Renamed',
          model: 'model-b',
          persistedStatus: 'IDLE',
          pendingRequestType: null,
        },
        { sessionId: 's-3' },
      ],
    });
    collector.stop();
  });

  it('keeps a delayed read older than reconciliation that began while it was in flight', async () => {
    const { collector, workspaceActivityService, findAgentSessionsByWorkspaceId, upsert } =
      createCollector();
    const read = deferred<[]>();
    findAgentSessionsByWorkspaceId.mockReturnValueOnce(read.promise);
    collector.start();
    workspaceActivityService.emit('session_activity_changed', { workspaceId: 'ws-1' });
    await vi.advanceTimersByTimeAsync(150);
    expect(findAgentSessionsByWorkspaceId).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    const reconciliationStarted = Date.now();
    read.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(upsert.mock.lastCall?.[3]).toBeLessThan(reconciliationStarted);
    collector.stop();
  });

  it.each(['remove', 'stop'] as const)('drops an in-flight summary read on %s', async (action) => {
    const { collector, workspaceActivityService, findAgentSessionsByWorkspaceId, upsert } =
      createCollector();
    const read = deferred<[]>();
    findAgentSessionsByWorkspaceId.mockReturnValueOnce(read.promise);
    collector.start();
    workspaceActivityService.emit('session_activity_changed', { workspaceId: 'ws-1' });
    await vi.advanceTimersByTimeAsync(150);
    expect(findAgentSessionsByWorkspaceId).toHaveBeenCalledOnce();
    if (action === 'remove') {
      collector.removeWorkspace('ws-1');
    } else {
      collector.stop();
      collector.start();
    }
    read.resolve([]);
    await vi.advanceTimersByTimeAsync(150);
    expect(upsert).not.toHaveBeenCalled();
    collector.stop();
  });

  it.each([
    { removedId: 'ws-1', expectedReads: 0 },
    { removedId: 'ws-other', expectedReads: 1 },
  ])(
    'fences unresolved routing only for the removed workspace ($removedId)',
    async ({ removedId, expectedReads }) => {
      const {
        collector,
        sessionDomainService,
        findWorkspaceIdForSession,
        findAgentSessionsByWorkspaceId,
      } = createCollector();
      const lookup = deferred<string>();
      findWorkspaceIdForSession.mockReturnValueOnce(lookup.promise);
      collector.start();
      sessionDomainService.emit('runtime_changed', { sessionId: 's-1' });
      collector.removeWorkspace(removedId);
      lookup.resolve('ws-1');
      await vi.advanceTimersByTimeAsync(150);
      expect(findAgentSessionsByWorkspaceId).toHaveBeenCalledTimes(expectedReads);

      sessionDomainService.emit('runtime_changed', { sessionId: 's-1' });
      await vi.advanceTimersByTimeAsync(150);
      expect(findAgentSessionsByWorkspaceId).toHaveBeenCalledTimes(expectedReads + 1);
      collector.stop();
    }
  );

  it('cancels a pending refresh for an already routed workspace on removal', async () => {
    const { collector, sessionDomainService, findAgentSessionsByWorkspaceId } = createCollector();
    collector.start();
    sessionDomainService.emit('runtime_changed', { sessionId: 's-1' });
    await vi.advanceTimersByTimeAsync(150);
    sessionDomainService.emit('runtime_changed', { sessionId: 's-1' });
    collector.removeWorkspace('ws-1');
    await vi.advanceTimersByTimeAsync(150);
    expect(findAgentSessionsByWorkspaceId).toHaveBeenCalledOnce();
    collector.stop();
  });

  it('shares one session lookup between events that arrive before it resolves', async () => {
    const { collector, sessionDomainService, findWorkspaceIdForSession } = createCollector();
    collector.start();

    for (let index = 0; index < 5; index++) {
      sessionDomainService.emit('runtime_changed', { sessionId: 's-1' });
    }
    await vi.advanceTimersByTimeAsync(150);

    expect(findWorkspaceIdForSession).toHaveBeenCalledOnce();
    collector.stop();
  });

  it('does not cache a lookup that finishes after the collector restarts', async () => {
    const { collector, sessionDomainService, findWorkspaceIdForSession } = createCollector();
    let resolveLookup!: (value: string) => void;
    findWorkspaceIdForSession.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLookup = resolve;
      })
    );
    collector.start();
    sessionDomainService.emit('runtime_changed', { sessionId: 's-1' });
    collector.stop();
    collector.start();
    resolveLookup('ws-1');
    await vi.advanceTimersByTimeAsync(150);

    sessionDomainService.emit('runtime_changed', { sessionId: 's-1' });
    await vi.advanceTimersByTimeAsync(150);

    // The stale lookup was not cached, so the restarted collector looks it up again.
    expect(findWorkspaceIdForSession).toHaveBeenCalledTimes(2);
    collector.stop();
  });

  it('forgets cached session workspaces when stopped', async () => {
    const { collector, sessionDomainService, findWorkspaceIdForSession } = createCollector();
    collector.start();
    sessionDomainService.emit('runtime_changed', { sessionId: 's-1' });
    await vi.advanceTimersByTimeAsync(150);
    collector.stop();

    collector.start();
    sessionDomainService.emit('runtime_changed', { sessionId: 's-1' });
    await vi.advanceTimersByTimeAsync(150);

    expect(findWorkspaceIdForSession).toHaveBeenCalledTimes(2);
    collector.stop();
  });
});

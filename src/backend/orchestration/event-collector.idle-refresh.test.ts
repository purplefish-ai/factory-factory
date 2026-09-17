import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SERVICE_LIMITS } from '@/backend/services/constants';
import {
  createEventCollectorOrchestrator,
  type EventCollectorDependencies,
} from './event-collector.orchestrator';

vi.mock('@/backend/services/github', () => ({
  PR_SNAPSHOT_UPDATED: 'pr_snapshot_updated',
  PR_URL_ATTACHED: 'pr_url_attached',
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
  AUTO_ITERATION_STATUS_CHANGED: 'auto_iteration_status_changed',
  WORKSPACE_STATE_CHANGED: 'workspace_state_changed',
}));

function createCollector() {
  const activity = new EventEmitter();
  const refresh = vi.fn().mockResolvedValue({ success: true });
  // Only event subscriptions and idle refreshes are exercised by this fixture.
  const dependencies = {
    createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    prSnapshotService: Object.assign(new EventEmitter(), { refreshWorkspace: refresh }),
    workspaceActivityService: activity,
    workspaceStateMachine: new EventEmitter(),
    ratchetService: new EventEmitter(),
    runScriptStateMachine: new EventEmitter(),
    workspaceAutoIterationService: new EventEmitter(),
    sessionDomainService: new EventEmitter(),
    workspaceSnapshotStore: {
      getAllWorkspaceIds: () => [],
      getByWorkspaceId: () => ({ projectId: 'project-1' }),
      upsert: vi.fn(),
    },
  } as unknown as EventCollectorDependencies;
  return { collector: createEventCollectorOrchestrator(dependencies), activity, refresh };
}

describe('idle PR refresh cooldown under capacity pressure', () => {
  afterEach(() => vi.useRealTimers());
  it('allows the first idle refresh at time zero and suppresses its immediate repeat', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { collector, activity, refresh } = createCollector();
    collector.start();
    activity.emit('workspace_idle', { workspaceId: 'ws-1' });
    activity.emit('workspace_idle', { workspaceId: 'ws-1' });
    expect(refresh).toHaveBeenCalledExactlyOnceWith('ws-1');
    collector.stop();
  });

  it('preserves live idle cooldowns at capacity and admits new work after expiry', () => {
    vi.useFakeTimers();
    const { collector, activity, refresh } = createCollector();
    collector.start();
    const handler = (event: { workspaceId: string }) => activity.emit('workspace_idle', event);
    const capacity = SERVICE_LIMITS.workspaceScopedCacheMaxEntries;
    vi.setSystemTime(100_000);
    for (let index = 0; index < capacity; index++) {
      handler({ workspaceId: `ws-${index}` });
    }
    expect(refresh).toHaveBeenCalledTimes(capacity);

    vi.setSystemTime(130_000);
    handler({ workspaceId: 'ws-0' });
    handler({ workspaceId: 'overflow' });
    handler({ workspaceId: 'ws-0' });
    expect(refresh).toHaveBeenCalledTimes(capacity + 2);

    // Refill all expired slots. No live entry may be evicted by another idle.
    for (let index = 0; index < capacity; index++) {
      handler({ workspaceId: `burst-${index}` });
    }
    const callsAtCapacity = refresh.mock.calls.length;
    handler({ workspaceId: 'overflow-again' });
    handler({ workspaceId: 'ws-0' });
    expect(refresh).toHaveBeenCalledTimes(callsAtCapacity);
    vi.setSystemTime(160_000);
    handler({ workspaceId: 'overflow-again' });
    expect(refresh).toHaveBeenCalledTimes(callsAtCapacity + 1);
    expect(refresh).toHaveBeenLastCalledWith('overflow-again');
    collector.stop();
  });
});

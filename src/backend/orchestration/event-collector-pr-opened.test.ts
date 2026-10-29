import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { PR_SNAPSHOT_UPDATED } from '@/backend/services/github';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  createEventCollectorOrchestrator,
  type EventCollectorDependencies,
} from './event-collector.orchestrator';

function fixture() {
  const prEvents = new EventEmitter();
  const notify = vi.fn().mockResolvedValue(undefined);
  const warn = vi.fn();
  const collector = createEventCollectorOrchestrator(
    unsafeCoerce<EventCollectorDependencies>({
      createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() }),
      fireLifecycleNotification: notify,
      prSnapshotService: prEvents,
      workspaceActivityService: new EventEmitter(),
      workspaceStateMachine: new EventEmitter(),
      ratchetService: new EventEmitter(),
      runScriptStateMachine: new EventEmitter(),
      sessionDomainService: new EventEmitter(),
      workspaceDataService: {
        subscribeAcceptedBranch: () => vi.fn(),
        findRatchetProjection: vi.fn().mockResolvedValue(null),
      },
      workspaceSnapshotStore: { getAllWorkspaceIds: () => [], upsert: vi.fn() },
    })
  );
  return { collector, prEvents, notify, warn };
}

it('notifies for each newly opened PR, without repeating on unchanged observations', () => {
  const { collector, prEvents, notify } = fixture();
  collector.start();
  try {
    const event = { workspaceId: 'w', prState: 'OPEN', previousPrState: 'NONE' };
    prEvents.emit(PR_SNAPSHOT_UPDATED, { ...event, prId: 'first' });
    prEvents.emit(PR_SNAPSHOT_UPDATED, { ...event, prId: 'first', previousPrState: 'OPEN' });
    prEvents.emit(PR_SNAPSHOT_UPDATED, { ...event, prId: 'second' });
    prEvents.emit(PR_SNAPSHOT_UPDATED, { ...event, prId: 'closed', prState: 'CLOSED' });
    expect(notify.mock.calls).toEqual([
      ['w', 'A pull request has been opened.'],
      ['w', 'A pull request has been opened.'],
    ]);
  } finally {
    collector.stop();
  }
});

it('logs failed PR-open notification persistence with its workspace and PR identity', async () => {
  const { collector, prEvents, notify, warn } = fixture();
  const error = new Error('database unavailable');
  notify.mockRejectedValueOnce(error);
  collector.start();
  try {
    prEvents.emit(PR_SNAPSHOT_UPDATED, {
      workspaceId: 'w',
      prId: 'first',
      previousPrState: 'NONE',
      prState: 'OPEN',
    });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('Failed to persist PR-open lifecycle notification', {
        workspaceId: 'w',
        prId: 'first',
        error: 'database unavailable',
      })
    );
  } finally {
    collector.stop();
  }
});

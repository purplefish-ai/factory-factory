import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { PR_SNAPSHOT_UPDATED } from '@/backend/services/github';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  createEventCollectorOrchestrator,
  type EventCollectorDependencies,
} from './event-collector.orchestrator';

it('notifies for each newly opened PR, without repeating on unchanged observations', () => {
  const prEvents = new EventEmitter();
  const notify = vi.fn().mockResolvedValue(undefined);
  const collector = createEventCollectorOrchestrator(
    unsafeCoerce<EventCollectorDependencies>({
      createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
      fireLifecycleNotification: notify,
      prSnapshotService: prEvents,
      workspaceActivityService: new EventEmitter(),
      workspaceStateMachine: new EventEmitter(),
      ratchetService: new EventEmitter(),
      runScriptStateMachine: new EventEmitter(),
      workspaceAutoIterationService: new EventEmitter(),
      sessionDomainService: new EventEmitter(),
      workspaceDataService: { findRatchetProjection: vi.fn().mockResolvedValue(null) },
      workspaceSnapshotStore: { getAllWorkspaceIds: () => [], upsert: vi.fn() },
    })
  );
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

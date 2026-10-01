import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEventCollectorOrchestrator,
  type EventCollectorDependencies,
  type EventCollectorOrchestrator,
} from '@/backend/orchestration/event-collector.orchestrator';
import { PR_URL_ATTACHED } from '@/backend/services/github';
import { RATCHET_DISPATCH_CHANGED } from '@/backend/services/ratchet';
import {
  deriveWorkspaceFlowState,
  WorkspaceSnapshotStore,
  type workspaceDataService,
} from '@/backend/services/workspace';
import { isWorkspaceDoneOrMerged } from '@/client/lib/workspace-archive';
import { deriveWorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';

type Projection = Awaited<ReturnType<typeof workspaceDataService.findRatchetProjection>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let collector: EventCollectorOrchestrator;

afterEach(() => {
  collector?.stop();
  vi.useRealTimers();
});

describe('failed PR attachment streaming', () => {
  it.each(['MERGED', 'CLOSED'] as const)(
    'clears a previous %s PR immediately and discards its in-flight projection',
    async (previousState) => {
      vi.useFakeTimers();
      vi.setSystemTime(2000);
      const store = new WorkspaceSnapshotStore();
      store.configure({
        deriveFlowState: (input) =>
          deriveWorkspaceFlowState({
            ...input,
            prUpdatedAt: input.prUpdatedAt ? new Date(input.prUpdatedAt) : null,
          }),
        deriveSidebarStatus: deriveWorkspaceSidebarStatus,
      });
      store.upsert(
        'ws-1',
        {
          projectId: 'project-1',
          name: 'Workspace',
          status: 'READY',
          createdAt: '2026-01-01T00:00:00.000Z',
          prUrl: 'https://github.com/org/repo/pull/1',
          prNumber: 1,
          prState: previousState,
          prCiStatus: 'SUCCESS',
          ratchetEnabled: true,
          ratchetState: previousState === 'MERGED' ? 'MERGED' : 'IDLE',
          hasMergeConflict: true,
        },
        'seed',
        1000
      );
      expect(isWorkspaceDoneOrMerged(store.getByWorkspaceId('ws-1'))).toBe(true);

      const oldRead = deferred<Projection>();
      const newRead = deferred<Projection>();
      const read = vi.fn().mockReturnValueOnce(oldRead.promise).mockReturnValue(newRead.promise);
      const prEvents = new EventEmitter();
      const ratchetEvents = new EventEmitter();
      const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const findSessions = vi.fn().mockResolvedValue([]);
      // The fixture uses real store/derivation/collector/worker; only event sources
      // and the delayed database boundary are substituted.
      const dependencies = {
        createLogger: () => logger,
        prSnapshotService: prEvents,
        ratchetService: ratchetEvents,
        workspaceDataService: { findRatchetProjection: read },
        workspaceSnapshotStore: store,
        workspaceActivityService: new EventEmitter(),
        workspaceStateMachine: new EventEmitter(),
        runScriptStateMachine: new EventEmitter(),
        workspaceAutoIterationService: new EventEmitter(),
        sessionDomainService: new EventEmitter(),
        sessionDataService: { findAgentSessionsByWorkspaceId: findSessions },
      } as unknown as EventCollectorDependencies;
      collector = createEventCollectorOrchestrator(dependencies);
      collector.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(findSessions).toHaveBeenCalledWith('ws-1');
      expect(logger.warn).not.toHaveBeenCalled();
      ratchetEvents.emit(RATCHET_DISPATCH_CHANGED, { workspaceId: 'ws-1' });
      expect(read).toHaveBeenCalledTimes(1);

      prEvents.emit(PR_URL_ATTACHED, {
        workspaceId: 'ws-1',
        prUrl: 'https://github.com/org/repo/pull/2',
      });
      const assertNeutral = () => {
        const snapshot = store.getByWorkspaceId('ws-1');
        expect(snapshot).toMatchObject({
          prUrl: 'https://github.com/org/repo/pull/2',
          prNumber: null,
          prState: 'NONE',
          prCiStatus: 'UNKNOWN',
          ratchetState: 'IDLE',
          hasMergeConflict: false,
        });
        expect(snapshot?.kanbanColumn).not.toBe('DONE');
        expect(snapshot?.sidebarStatus.ciState).toBe('UNKNOWN');
        expect(isWorkspaceDoneOrMerged(snapshot)).toBe(false);
      };
      assertNeutral();

      oldRead.resolve({
        status: 'READY',
        ratchetEnabled: true,
        ratchetState: previousState === 'MERGED' ? 'MERGED' : 'IDLE',
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
        ratchetDispatchStalled: false,
        prHasMergeConflict: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(2);
      // The new read is still pending: the old result cannot reopen the
      // confirmation bypass while waiting for the replacement projection.
      assertNeutral();
    }
  );
});

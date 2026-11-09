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
  SNAPSHOT_CHANGED,
  WorkspaceSnapshotStore,
  type workspaceDataService,
} from '@/backend/services/workspace';
import { prProjectionDefaults } from '@/backend/testing/pr-projection-fixture';
import { isWorkspaceDoneOrMerged } from '@/client/lib/workspace-archive';
import { deriveWorkspaceSidebarStatus } from '@/shared/core';
import { deriveWorkspacePRSelection, type WorkspacePullRequest } from '@/shared/workspace-pr';
import { deriveWorkspacePRSummary } from '@/shared/workspace-pr-summary';

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

function attachedCollection(previousState: 'MERGED' | 'CLOSED'): NonNullable<Projection> {
  const pr = (id: string, number: number, state: WorkspacePullRequest['state']) => ({
    id,
    revision: state === 'NONE' ? 0 : 1,
    url: `https://github.com/org/repo/pull/${number}`,
    number: state === 'NONE' ? null : number,
    title: null,
    headRefName: null,
    baseRefName: null,
    state,
    reviewState: null,
    ciStatus: state === 'NONE' ? ('UNKNOWN' as const) : ('SUCCESS' as const),
    hasMergeConflict: false,
    syncedAt: null,
  });
  const prs = [pr('pr-1', 1, previousState), pr('pr-2', 2, 'NONE')];
  const selection = deriveWorkspacePRSelection(prs);
  const prSummary = deriveWorkspacePRSummary(prs, true);
  return {
    ...prProjectionDefaults,
    status: 'READY',
    ratchetEnabled: true,
    ratchetState: prSummary.ratchetState,
    prMonitoring: {
      deliveryMode: 'MAIN',
      enabled: true,
      recipientSessionId: 'main',
      bindingRevision: 1,
      pauseReason: null,
      pendingEventCount: 0,
    },
    prs,
    prCollectionRevision: prs.reduce((total, row) => total + row.revision + 1, 0),
    ...selection,
    prSummary,
    prUrl: selection.selectedPr?.url ?? null,
    prNumber: selection.selectedPr?.number ?? null,
    prState: prSummary.state,
    prCiStatus: prSummary.ciStatus,
    prHasMergeConflict: prSummary.hasMergeConflict,
  };
}

describe('PR attachment streaming', () => {
  it.each(['MERGED', 'CLOSED'] as const)(
    'discards an in-flight %s projection and publishes the attached collection',
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
      const checkWorkspaceById = vi.fn().mockResolvedValue(null);
      const ratchetEvents = Object.assign(new EventEmitter(), { checkWorkspaceById });
      const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const findSessions = vi.fn().mockResolvedValue([]);
      // The fixture uses real store/derivation/collector/worker; only event sources
      // and the delayed database boundary are substituted.
      const dependencies = {
        createLogger: () => logger,
        prSnapshotService: prEvents,
        ratchetService: ratchetEvents,
        workspaceDataService: {
          subscribeAcceptedBranch: () => vi.fn(),
          findRatchetProjection: read,
        },
        workspaceSnapshotStore: store,
        workspaceActivityService: new EventEmitter(),
        workspaceStateMachine: new EventEmitter(),
        runScriptStateMachine: new EventEmitter(),
        sessionDomainService: new EventEmitter(),
        sessionDataService: { findAgentSessionsByWorkspaceId: findSessions },
        chatEventForwarderService: { getAllPendingRequests: () => new Map() },
        computePendingRequestType: () => null,
      } as unknown as EventCollectorDependencies;
      collector = createEventCollectorOrchestrator(dependencies);
      collector.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(findSessions).toHaveBeenCalledWith('ws-1');
      expect(logger.warn).not.toHaveBeenCalled();
      ratchetEvents.emit(RATCHET_DISPATCH_CHANGED, { workspaceId: 'ws-1' });
      expect(read).toHaveBeenCalledTimes(1);

      const published: unknown[] = [];
      store.on(SNAPSHOT_CHANGED, () => published.push(store.getByWorkspaceId('ws-1')));
      prEvents.emit(PR_URL_ATTACHED, {
        workspaceId: 'ws-1',
        prId: 'pr-2',
        prUrl: 'https://github.com/org/repo/pull/2',
      });

      oldRead.resolve({
        ...prProjectionDefaults,
        status: 'READY',
        ratchetEnabled: true,
        ratchetState: previousState === 'MERGED' ? 'MERGED' : 'IDLE',
        prMonitoring: {
          deliveryMode: 'MAIN',
          enabled: true,
          recipientSessionId: 'main',
          bindingRevision: 1,
          pauseReason: null,
          pendingEventCount: 0,
        },
        prHasMergeConflict: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(2);
      // The superseded read cannot publish while the replacement is pending.
      expect(published).toEqual([]);

      newRead.resolve(attachedCollection(previousState));
      await vi.advanceTimersByTimeAsync(0);
      const snapshot = store.getByWorkspaceId('ws-1');
      expect(snapshot).toMatchObject({
        prUrl: 'https://github.com/org/repo/pull/2',
        prNumber: null,
        prState: 'OPEN',
        prCiStatus: 'UNKNOWN',
        ratchetState: 'CI_RUNNING',
        hasMergeConflict: false,
      });
      expect(snapshot?.sidebarStatus.ciState).not.toBe('MERGED');
      expect(snapshot?.prs?.map((pr) => pr.id)).toEqual(['pr-1', 'pr-2']);
      expect(snapshot?.kanbanColumn).not.toBe('DONE');
      expect(isWorkspaceDoneOrMerged(snapshot)).toBe(false);
      // The selected PR changed, so monitoring is recomputed immediately.
      expect(checkWorkspaceById).toHaveBeenCalledExactlyOnceWith('ws-1');
      expect(logger.warn).not.toHaveBeenCalled();
    }
  );
});

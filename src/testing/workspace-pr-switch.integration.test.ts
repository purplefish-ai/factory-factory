// Cross-layer regressions: complete collections through live snapshots and archive gating.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEventCollectorOrchestrator,
  type EventCollectorDependencies,
  type EventCollectorOrchestrator,
} from '@/backend/orchestration/event-collector.orchestrator';
import { PR_SNAPSHOT_UPDATED, PR_URL_ATTACHED } from '@/backend/services/github';
import { RATCHET_DISPATCH_CHANGED } from '@/backend/services/ratchet';
import {
  deriveWorkspaceFlowState,
  WorkspaceSnapshotStore,
  type workspaceDataService,
} from '@/backend/services/workspace';
import { isWorkspaceDoneOrMerged } from '@/client/lib/workspace-archive';
import { deriveWorkspaceSidebarStatus } from '@/shared/core';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';
import { deriveWorkspacePRSummary } from '@/shared/workspace-pr-summary';

type Projection = Awaited<ReturnType<typeof workspaceDataService.findRatchetProjection>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve: (value: T) => resolve(value),
  };
}
function pr(
  id: string,
  state: WorkspacePullRequest['state'] = 'MERGED',
  url = `https://github.com/org/repo/pull/${id === 'a' ? 41 : 42}`
): WorkspacePullRequest {
  return {
    id,
    url,
    number: Number(new URL(url).pathname.split('/').at(-1)),
    title: null,
    headRefName: null,
    baseRefName: null,
    state,
    reviewState: null,
    ciStatus: state === 'MERGED' ? 'SUCCESS' : 'PENDING',
    hasMergeConflict: false,
    syncedAt: null,
    ratchet: {
      lastCheckedAt: null,
      dispatchOutcome: null,
      dispatchRetryCount: 0,
      dispatchStalled: false,
    },
  };
}
function projection(prs: WorkspacePullRequest[]): NonNullable<Projection> {
  const summary = deriveWorkspacePRSummary(prs, true);
  return {
    status: 'READY',
    prs,
    prSummary: summary,
    prUrl: prs.length === 1 ? prs[0]!.url : null,
    prNumber: prs.length === 1 ? prs[0]!.number : null,
    prState: summary.state,
    prCiStatus: summary.ciStatus,
    prUpdatedAt: null,
    prHasMergeConflict: summary.hasMergeConflict,
    ratchetEnabled: true,
    ratchetState: summary.ratchetState,
    ratchetDispatchOutcome: null,
    ratchetDispatchRetryCount: 0,
    ratchetDispatchStalled: summary.dispatchStalled,
  };
}
let collector: EventCollectorOrchestrator;
function setup(prs = [pr('a')]) {
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
    'ws',
    { projectId: 'p', hasHadSessions: true, ...projection(prs), prUpdatedAt: null },
    'seed',
    1
  );
  const events = new EventEmitter(),
    ratchet = new EventEmitter(),
    read = vi.fn<typeof workspaceDataService.findRatchetProjection>();
  const dependencies = {
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    getWorkspaceLinearContext: vi.fn().mockResolvedValue(null),
    prSnapshotService: events,
    ratchetService: Object.assign(ratchet, { checkWorkspaceById: vi.fn().mockResolvedValue(null) }),
    workspaceDataService: { findRatchetProjection: read },
    workspaceSnapshotStore: store,
    workspaceActivityService: new EventEmitter(),
    workspaceStateMachine: new EventEmitter(),
    runScriptStateMachine: new EventEmitter(),
    workspaceAutoIterationService: new EventEmitter(),
    sessionDomainService: new EventEmitter(),
    sessionDataService: { findAgentSessionsByWorkspaceId: vi.fn().mockResolvedValue([]) },
  } as unknown as EventCollectorDependencies;
  collector = createEventCollectorOrchestrator(dependencies);
  collector.start();
  return {
    store,
    events,
    ratchet,
    read,
    checkWorkspaceById: dependencies.ratchetService.checkWorkspaceById,
  };
}
function assertOpen(store: WorkspaceSnapshotStore) {
  const snapshot = store.getByWorkspaceId('ws')!;
  expect(snapshot.prSummary?.hasNonterminal).toBe(true);
  expect(snapshot.prState).toBe('OPEN');
  expect(snapshot.kanbanColumn).not.toBe('DONE');
  expect(isWorkspaceDoneOrMerged(snapshot)).toBe(false);
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  collector?.stop();
  vi.useRealTimers();
});
describe('multiple PR snapshot publication', () => {
  it.each(['https://github.com/org/repo/pull/42', 'https://github.com/org/other/pull/41'])(
    'retains merged siblings when another PR opens: %s',
    async (url) => {
      const { store, events, read } = setup(),
        pending = deferred<Projection>();
      read.mockReturnValue(pending.promise);
      events.emit(PR_SNAPSHOT_UPDATED, {
        workspaceId: 'ws',
        prId: 'b',
        prUrl: url,
        prNumber: Number(new URL(url).pathname.split('/').at(-1)),
        prState: 'OPEN',
        prCiStatus: 'PENDING',
        prReviewState: null,
      });
      assertOpen(store);
      expect(store.getByWorkspaceId('ws')?.prs).toEqual([
        pr('a'),
        expect.objectContaining({
          id: 'b',
          url,
          number: url.endsWith('/42') ? 42 : 41,
          state: 'OPEN',
        }),
      ]);
      pending.resolve(projection([pr('a'), pr('b', 'OPEN', url)]));
      await vi.advanceTimersByTimeAsync(0);
      assertOpen(store);
    }
  );
  it('keeps unsynchronized attachments visible and requires archive confirmation during an outage', async () => {
    const { store, events, read } = setup();
    read.mockRejectedValue(new Error('database unavailable'));
    events.emit(PR_URL_ATTACHED, { workspaceId: 'ws', prId: 'b', prUrl: pr('b').url });
    assertOpen(store);
    expect(store.getByWorkspaceId('ws')?.prs?.[1]).toMatchObject({
      id: 'b',
      state: 'NONE',
      ciStatus: 'UNKNOWN',
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(read).toHaveBeenCalledTimes(3);
    assertOpen(store);
  });
  it('discards a stale merged collection before the newer read completes', async () => {
    const { store, events, ratchet, read } = setup(),
      old = deferred<Projection>(),
      fresh = deferred<Projection>();
    read.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    ratchet.emit(RATCHET_DISPATCH_CHANGED, { workspaceId: 'ws' });
    events.emit(PR_URL_ATTACHED, { workspaceId: 'ws', prId: 'b', prUrl: pr('b').url });
    old.resolve(projection([pr('a')]));
    await vi.advanceTimersByTimeAsync(0);
    assertOpen(store);
    expect(read).toHaveBeenCalledTimes(2);
    fresh.resolve(projection([pr('a'), pr('b', 'OPEN')]));
    await vi.advanceTimersByTimeAsync(0);
    assertOpen(store);
  });
  it('handles reopened PRs by their stable ID without duplicating an association', () => {
    const { store, events, read } = setup([pr('a', 'CLOSED')]);
    read.mockReturnValue(deferred<Projection>().promise);
    events.emit(PR_SNAPSHOT_UPDATED, {
      workspaceId: 'ws',
      prId: 'a',
      prUrl: pr('a').url,
      prNumber: 41,
      prState: 'OPEN',
      prCiStatus: 'PENDING',
      prReviewState: null,
    });
    assertOpen(store);
    expect(store.getByWorkspaceId('ws')?.prs).toHaveLength(1);
  });
  it('immediately checks ratchet when one of multiple closed PRs reopens', () => {
    const { store, events, read, checkWorkspaceById } = setup([
      pr('a', 'CLOSED'),
      pr('b', 'CLOSED'),
    ]);
    read.mockReturnValue(deferred<Projection>().promise);
    expect(store.getByWorkspaceId('ws')).toMatchObject({ prUrl: null, prNumber: null });
    events.emit(PR_SNAPSHOT_UPDATED, {
      workspaceId: 'ws',
      prId: 'b',
      prUrl: pr('b').url,
      prNumber: 42,
      prState: 'OPEN',
      prCiStatus: 'PENDING',
      prReviewState: null,
    });
    assertOpen(store);
    expect(checkWorkspaceById).toHaveBeenCalledWith('ws', { bypassPrFetchCooldown: true });
  });

  it('keeps a workspace active when one PR merges and its sibling is still open', () => {
    const { store, events, read } = setup([pr('a', 'OPEN'), pr('b', 'OPEN')]);
    read.mockReturnValue(deferred<Projection>().promise);
    events.emit(PR_SNAPSHOT_UPDATED, {
      workspaceId: 'ws',
      prId: 'a',
      prUrl: pr('a').url,
      prNumber: 41,
      prState: 'MERGED',
      prCiStatus: 'SUCCESS',
      prReviewState: null,
    });
    assertOpen(store);
    expect(store.getByWorkspaceId('ws')?.prs?.[0]?.state).toBe('MERGED');
  });
  it('publishes the full terminal summary when every PR is complete', () => {
    const { store, events, read } = setup([pr('a'), pr('b', 'OPEN')]);
    read.mockReturnValue(deferred<Projection>().promise);
    events.emit(PR_SNAPSHOT_UPDATED, {
      workspaceId: 'ws',
      prId: 'b',
      prUrl: pr('b').url,
      prNumber: 42,
      prState: 'MERGED',
      prCiStatus: 'SUCCESS',
      prReviewState: null,
    });
    expect(isWorkspaceDoneOrMerged(store.getByWorkspaceId('ws'))).toBe(true);
    expect(store.getByWorkspaceId('ws')?.prSummary?.totalCount).toBe(2);
  });
});

// Cross-layer regression: backend publication through the client archive gate.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEventCollectorOrchestrator,
  type EventCollectorDependencies,
  type EventCollectorOrchestrator,
} from '@/backend/orchestration/snapshots/event-collector.orchestrator';
import { PR_SNAPSHOT_UPDATED, type PRSnapshotUpdatedEvent } from '@/backend/services/github';
import { RATCHET_DISPATCH_CHANGED } from '@/backend/services/ratchet';
import {
  deriveWorkspaceFlowState,
  SNAPSHOT_CHANGED,
  WorkspaceSnapshotStore,
  type workspaceDataService,
} from '@/backend/services/workspace';
import { isWorkspaceDoneOrMerged } from '@/client/lib/workspace-archive';
import { deriveWorkspaceSidebarStatus, type CIStatus, type PRState } from '@/shared/core';
import { deriveWorkspacePRSelection } from '@/shared/workspace-pr';
import { deriveWorkspacePRSummary } from '@/shared/workspace-pr-summary';

type Projection = Awaited<ReturnType<typeof workspaceDataService.findRatchetProjection>>;

function projection(
  prState: PRState,
  prCiStatus: CIStatus,
  prNumber: number,
  prUrl: string
): NonNullable<Projection> {
  const prs = [
    {
      id: `pr-${prUrl}`,
      revision: 1,
      url: prUrl,
      number: prNumber,
      title: null,
      headRefName: null,
      baseRefName: null,
      state: prState,
      reviewState: null,
      ciStatus: prCiStatus,
      hasMergeConflict: false,
      syncedAt: null,
    },
  ];
  const prSummary = deriveWorkspacePRSummary(prs, true);
  return {
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
    prCollectionRevision: prs.reduce((total, pr) => total + pr.revision + 1, 0),
    ...deriveWorkspacePRSelection(prs),
    prSummary,
    prUrl,
    prNumber,
    prState: prSummary.state,
    prCiStatus: prSummary.ciStatus,
    prUpdatedAt: null,
    prHasMergeConflict: prSummary.hasMergeConflict,
  };
}
const mergedProjection = projection('MERGED', 'SUCCESS', 41, 'https://github.com/org/repo/pull/41');
const openProjection = projection('OPEN', 'PENDING', 42, 'https://github.com/org/repo/pull/42');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createFixture(previous: { prNumber?: number; prUrl?: string; prState?: PRState } = {}) {
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
    {
      projectId: 'project',
      status: 'READY',
      hasHadSessions: true,
      prNumber: 41,
      prUrl: 'https://github.com/org/repo/pull/41',
      prState: 'MERGED',
      prCiStatus: 'SUCCESS',
      ratchetEnabled: true,
      ratchetState: 'MERGED',
      ...previous,
    },
    'test',
    1
  );
  const prs = new EventEmitter();
  const ratchet = new EventEmitter();
  const read = vi.fn<typeof workspaceDataService.findRatchetProjection>();
  const check = vi.fn().mockResolvedValue(null);
  // Real emitters and store exercise the entire publication path; only domain
  // IO is stubbed so this test cannot fetch GitHub or archive a live workspace.
  const dependencies = {
    createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    getWorkspaceLinearContext: vi.fn().mockResolvedValue(null),
    prSnapshotService: prs,
    ratchetService: Object.assign(ratchet, { checkWorkspaceById: check }),
    workspaceDataService: { subscribeAcceptedBranch: () => vi.fn(), findRatchetProjection: read },
    workspaceSnapshotStore: store,
    workspaceActivityService: new EventEmitter(),
    workspaceStateMachine: new EventEmitter(),
    runScriptStateMachine: new EventEmitter(),
    sessionDomainService: new EventEmitter(),
    sessionDataService: { findAgentSessionsByWorkspaceId: vi.fn().mockResolvedValue([]) },
  } as unknown as EventCollectorDependencies;
  const collector = createEventCollectorOrchestrator(dependencies);
  return { store, prs, ratchet, read, check, collector };
}

function emitOpen(prs: EventEmitter, overrides: Partial<PRSnapshotUpdatedEvent> = {}) {
  prs.emit(PR_SNAPSHOT_UPDATED, {
    prId: 'pr-https://github.com/org/repo/pull/42',
    workspaceId: 'ws',
    prNumber: 42,
    prUrl: 'https://github.com/org/repo/pull/42',
    prState: 'OPEN',
    prCiStatus: 'PENDING',
    prReviewState: null,
    ...overrides,
  } satisfies PRSnapshotUpdatedEvent);
}

function expectOpen(store: WorkspaceSnapshotStore) {
  const entry = store.getByWorkspaceId('ws')!;
  expect(entry.prState).toBe('OPEN');
  expect(entry.ratchetState).not.toBe('MERGED');
  expect(entry.statusReason.code).toBe('WAITING_FOR_CI');
  expect(entry.kanbanColumn).toBe('WORKING');
  expect(entry.sidebarStatus.ciState).not.toBe('MERGED');
  expect(isWorkspaceDoneOrMerged(entry)).toBe(false);
}

describe('successful PR switch snapshot publication', () => {
  let collector: EventCollectorOrchestrator;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    collector?.stop();
    vi.useRealTimers();
  });

  it.each([
    { label: 'new number and URL', prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42' },
    {
      label: 'same number in a different repository',
      prNumber: 41,
      prUrl: 'https://github.com/org/other/pull/41',
    },
  ])(
    'publishes the accepted open projection and refreshes monitoring for $label',
    async ({ prNumber, prUrl }) => {
      const fixture = createFixture();
      collector = fixture.collector;
      const pending = deferred<Projection>();
      fixture.read.mockReturnValue(pending.promise);
      collector.start();
      const published: string[] = [];
      fixture.store.on(SNAPSHOT_CHANGED, () => {
        published.push(fixture.store.getByWorkspaceId('ws')!.ratchetState);
      });

      emitOpen(fixture.prs, { prId: `pr-${prUrl}`, prNumber, prUrl });
      pending.resolve(projection('OPEN', 'PENDING', prNumber, prUrl));
      await vi.advanceTimersByTimeAsync(0);

      expect(published).not.toContain('MERGED');
      expect(fixture.store.getByWorkspaceId('ws')!.ratchetState).toBe('CI_RUNNING');
      expectOpen(fixture.store);
      expect(fixture.check).toHaveBeenCalledExactlyOnceWith('ws');
    }
  );

  it('discards an old in-flight MERGED projection before a fresh read completes', async () => {
    const fixture = createFixture();
    collector = fixture.collector;
    const oldRead = deferred<Projection>();
    const newRead = deferred<Projection>();
    fixture.read.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    collector.start();
    fixture.ratchet.emit(RATCHET_DISPATCH_CHANGED, { workspaceId: 'ws' });
    emitOpen(fixture.prs);
    const publishedRatchetStates: string[] = [];
    fixture.store.on(SNAPSHOT_CHANGED, () => {
      publishedRatchetStates.push(fixture.store.getByWorkspaceId('ws')!.ratchetState);
    });

    oldRead.resolve(mergedProjection);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.read).toHaveBeenCalledTimes(2);
    expect(publishedRatchetStates).toEqual([]);

    newRead.resolve(openProjection);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.store.getByWorkspaceId('ws')!.ratchetState).toBe('CI_RUNNING');
    expectOpen(fixture.store);
  });

  it('does not refresh monitoring when the accepted PR identity is unchanged', async () => {
    const fixture = createFixture({ prState: 'OPEN' });
    collector = fixture.collector;
    fixture.read.mockResolvedValue(
      projection('OPEN', 'PENDING', 41, 'https://github.com/org/repo/pull/41')
    );
    collector.start();
    emitOpen(fixture.prs, {
      prId: 'pr-https://github.com/org/repo/pull/41',
      prNumber: 41,
      prUrl: 'https://github.com/org/repo/pull/41',
    });
    await vi.advanceTimersByTimeAsync(0);

    expectOpen(fixture.store);
    expect(fixture.check).not.toHaveBeenCalled();
  });

  it('refreshes monitoring when the same closed PR reopens', async () => {
    const fixture = createFixture({ prState: 'CLOSED' });
    collector = fixture.collector;
    fixture.read.mockResolvedValue(
      projection('OPEN', 'PENDING', 41, 'https://github.com/org/repo/pull/41')
    );
    collector.start();
    emitOpen(fixture.prs, {
      prId: 'pr-https://github.com/org/repo/pull/41',
      prNumber: 41,
      prUrl: 'https://github.com/org/repo/pull/41',
    });
    await vi.advanceTimersByTimeAsync(0);

    expectOpen(fixture.store);
    expect(fixture.check).toHaveBeenCalledExactlyOnceWith('ws');
  });

  it('reports a newly linked merged PR as done', async () => {
    const fixture = createFixture();
    collector = fixture.collector;
    fixture.read.mockResolvedValue(
      projection('MERGED', 'SUCCESS', 42, 'https://github.com/org/repo/pull/42')
    );
    collector.start();
    emitOpen(fixture.prs, { prState: 'MERGED', prCiStatus: 'SUCCESS' });
    await vi.advanceTimersByTimeAsync(0);

    const entry = fixture.store.getByWorkspaceId('ws')!;
    expect(entry.statusReason.code).toBe('MERGED');
    expect(entry.kanbanColumn).toBe('DONE');
    expect(entry.sidebarStatus.ciState).toBe('MERGED');
    expect(isWorkspaceDoneOrMerged(entry)).toBe(true);
  });

  it('preserves the projection for an unchanged merged PR', async () => {
    const fixture = createFixture();
    collector = fixture.collector;
    fixture.read.mockResolvedValue(mergedProjection);
    collector.start();
    emitOpen(fixture.prs, {
      prId: 'pr-https://github.com/org/repo/pull/41',
      prNumber: 41,
      prUrl: 'https://github.com/org/repo/pull/41',
      prState: 'MERGED',
      prCiStatus: 'SUCCESS',
    });
    await vi.advanceTimersByTimeAsync(0);

    const entry = fixture.store.getByWorkspaceId('ws')!;
    expect(entry.ratchetState).toBe('MERGED');
    expect(entry.kanbanColumn).toBe('DONE');
    expect(isWorkspaceDoneOrMerged(entry)).toBe(true);
    expect(fixture.check).not.toHaveBeenCalled();
  });
});

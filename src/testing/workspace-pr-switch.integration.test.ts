// Cross-layer regression: backend publication through the client archive gate.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEventCollectorOrchestrator,
  type EventCollectorDependencies,
  type EventCollectorOrchestrator,
} from '@/backend/orchestration/event-collector.orchestrator';
import { PR_SNAPSHOT_UPDATED, type PRSnapshotUpdatedEvent } from '@/backend/services/github';
import { RATCHET_DISPATCH_CHANGED } from '@/backend/services/ratchet';
import {
  deriveWorkspaceFlowState,
  SNAPSHOT_CHANGED,
  WorkspaceSnapshotStore,
  type workspaceDataService,
} from '@/backend/services/workspace';
import { isWorkspaceDoneOrMerged } from '@/client/lib/workspace-archive';
import { deriveWorkspaceSidebarStatus, type PRState } from '@/shared/core';

type Projection = Awaited<ReturnType<typeof workspaceDataService.findRatchetProjection>>;

const mergedProjection = {
  status: 'READY',
  ratchetEnabled: true,
  ratchetState: 'MERGED',
  ratchetDispatchOutcome: null,
  ratchetDispatchRetryCount: 0,
  ratchetDispatchStalled: false,
  prHasMergeConflict: false,
} satisfies Projection;

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
    prSnapshotService: prs,
    ratchetService: Object.assign(ratchet, { checkWorkspaceById: check }),
    workspaceDataService: { findRatchetProjection: read },
    workspaceSnapshotStore: store,
    workspaceActivityService: new EventEmitter(),
    workspaceStateMachine: new EventEmitter(),
    runScriptStateMachine: new EventEmitter(),
    workspaceAutoIterationService: new EventEmitter(),
    sessionDomainService: new EventEmitter(),
    sessionDataService: { findAgentSessionsByWorkspaceId: vi.fn().mockResolvedValue([]) },
  } as unknown as EventCollectorDependencies;
  const collector = createEventCollectorOrchestrator(dependencies);
  return { store, prs, ratchet, read, check, collector };
}

function emitOpen(prs: EventEmitter, overrides: Partial<PRSnapshotUpdatedEvent> = {}) {
  prs.emit(PR_SNAPSHOT_UPDATED, {
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
    { label: 'new number and URL', overrides: {} },
    { label: 'new number without URL', overrides: { prUrl: undefined } },
    {
      label: 'same number in a different repository',
      overrides: {
        prNumber: 41,
        prUrl: 'https://github.com/org/other/pull/41',
      },
    },
  ])('clears MERGED before notifying subscribers for $label', async ({ overrides }) => {
    const fixture = createFixture();
    collector = fixture.collector;
    const pending = deferred<Projection>();
    fixture.read.mockReturnValue(pending.promise);
    collector.start();
    fixture.store.on(SNAPSHOT_CHANGED, () => expectOpen(fixture.store));

    emitOpen(fixture.prs, overrides);

    expectOpen(fixture.store);
    pending.resolve({ ...mergedProjection, ratchetState: 'CI_RUNNING' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.store.getByWorkspaceId('ws')!.ratchetState).toBe('CI_RUNNING');
    expectOpen(fixture.store);
  });

  it('remains safe when authoritative projection reads exhaust their retries', async () => {
    const fixture = createFixture();
    collector = fixture.collector;
    fixture.read.mockRejectedValue(new Error('database unavailable'));
    collector.start();
    emitOpen(fixture.prs);
    await vi.advanceTimersByTimeAsync(4000);

    expect(fixture.read).toHaveBeenCalledTimes(3);
    expectOpen(fixture.store);
  });

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
    expect(publishedRatchetStates).not.toContain('MERGED');
    expectOpen(fixture.store);

    newRead.resolve({ ...mergedProjection, ratchetState: 'CI_RUNNING' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.store.getByWorkspaceId('ws')!.ratchetState).toBe('CI_RUNNING');
    expectOpen(fixture.store);
  });

  it('preserves a current open PR projection when its identity is unchanged', () => {
    const fixture = createFixture({ prState: 'OPEN' });
    collector = fixture.collector;
    fixture.store.upsert('ws', { ratchetState: 'CI_FAILED' }, 'test', 2);
    fixture.read.mockReturnValue(deferred<Projection>().promise);
    collector.start();
    emitOpen(fixture.prs, { prNumber: 41, prUrl: undefined });

    expect(fixture.store.getByWorkspaceId('ws')!.ratchetState).toBe('CI_FAILED');
    expect(fixture.check).not.toHaveBeenCalled();
  });

  it('clears a stale merged projection when the same closed PR reopens', () => {
    const fixture = createFixture({ prState: 'CLOSED' });
    collector = fixture.collector;
    fixture.read.mockReturnValue(deferred<Projection>().promise);
    collector.start();
    emitOpen(fixture.prs, { prNumber: 41, prUrl: undefined });

    expectOpen(fixture.store);
    expect(fixture.check).toHaveBeenCalledExactlyOnceWith('ws', { bypassPrFetchCooldown: true });
  });

  it('still reports a newly linked merged PR as done during projection refresh', () => {
    const fixture = createFixture();
    collector = fixture.collector;
    fixture.read.mockReturnValue(deferred<Projection>().promise);
    collector.start();
    emitOpen(fixture.prs, { prState: 'MERGED', prCiStatus: 'SUCCESS' });

    const entry = fixture.store.getByWorkspaceId('ws')!;
    expect(entry.statusReason.code).toBe('MERGED');
    expect(entry.kanbanColumn).toBe('DONE');
    expect(entry.sidebarStatus.ciState).toBe('MERGED');
    expect(isWorkspaceDoneOrMerged(entry)).toBe(true);
  });

  it('preserves the projection for an unchanged merged PR', () => {
    const fixture = createFixture();
    collector = fixture.collector;
    fixture.read.mockReturnValue(deferred<Projection>().promise);
    collector.start();
    emitOpen(fixture.prs, {
      prNumber: 41,
      prUrl: 'https://github.com/org/repo/pull/41',
      prState: 'MERGED',
      prCiStatus: 'SUCCESS',
    });

    const entry = fixture.store.getByWorkspaceId('ws')!;
    expect(entry.ratchetState).toBe('MERGED');
    expect(entry.kanbanColumn).toBe('DONE');
    expect(isWorkspaceDoneOrMerged(entry)).toBe(true);
    expect(fixture.check).not.toHaveBeenCalled();
  });
});

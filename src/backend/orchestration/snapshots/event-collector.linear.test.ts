import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { PR_DETACHED, PR_SNAPSHOT_UPDATED, PR_URL_ATTACHED } from '@/backend/services/github';
import { deriveWorkspaceFlowState, WorkspaceSnapshotStore } from '@/backend/services/workspace';
import { deriveWorkspaceSidebarStatus } from '@/shared/core';
import { createEventCollectorOrchestrator } from './event-collector.orchestrator';

function createHarness(prState: 'OPEN' | 'MERGED' | 'CLOSED' | null = 'OPEN') {
  const store = new WorkspaceSnapshotStore();
  store.configure({
    deriveFlowState: (input) =>
      deriveWorkspaceFlowState({
        ...input,
        prUpdatedAt: input.prUpdatedAt ? new Date(input.prUpdatedAt) : null,
      }),
    deriveSidebarStatus: deriveWorkspaceSidebarStatus,
  });
  if (prState) {
    store.upsert(
      'ws-1',
      {
        projectId: 'project-1',
        status: 'READY',
        prState,
        prNumber: 7,
        prUrl: 'https://github.com/org/repo/pull/7',
      },
      'reconciliation',
      1
    );
  }
  const prSnapshotService = new EventEmitter();
  const markIssueCompleted = vi.fn().mockResolvedValue(true);
  const signalIssueCompletion = () => {
    const called = Promise.withResolvers<void>();
    markIssueCompleted.mockImplementationOnce(() => {
      called.resolve();
      return Promise.resolve(true);
    });
    return called.promise;
  };
  const getWorkspaceLinearContext = vi
    .fn()
    .mockResolvedValue({ apiKey: 'test-key', linearIssueId: 'issue-1' });
  const findById = vi.fn().mockResolvedValue(null);
  const findRatchetProjection = vi.fn().mockImplementation(async () => await findById());
  const checkWorkspaceById = vi.fn().mockResolvedValue(null);
  const ratchetService = Object.assign(new EventEmitter(), { checkWorkspaceById });
  const workspaceStateMachine = new EventEmitter();
  const collector = createEventCollectorOrchestrator({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    getWorkspaceLinearContext,
    linearStateSyncService: { markIssueCompleted },
    prSnapshotService,
    prFetchCoordinator: { removeWorkspace: vi.fn() },
    ratchetService,
    runScriptStateMachine: new EventEmitter(),
    sessionDomainService: new EventEmitter(),
    workspaceActivityService: Object.assign(new EventEmitter(), { clearWorkspace: vi.fn() }),
    workspaceStateMachine,
    sessionLifecycleService: { stopWorkspaceSessions: vi.fn().mockResolvedValue(undefined) },
    terminalService: { destroyWorkspaceTerminals: vi.fn() },
    workspaceDataService: {
      subscribeAcceptedBranch: () => vi.fn(),
      findById,
      findRatchetProjection,
    },
    workspaceSnapshotStore: store,
  } as never);
  collector.start();
  const emitMerge = (
    prNumber = 7,
    prUrl = `https://github.com/org/repo/pull/${prNumber}`,
    prId = 'selected'
  ) =>
    prSnapshotService.emit(PR_SNAPSHOT_UPDATED, {
      workspaceId: 'ws-1',
      prId,
      prNumber,
      prUrl,
      prState: 'MERGED',
      prCiStatus: 'SUCCESS',
      prReviewState: null,
    });
  // Accept a merged observation whose authoritative projection selects that PR.
  const acceptMerge = (prNumber = 7) => {
    const prUrl = `https://github.com/org/repo/pull/${prNumber}`;
    findById.mockResolvedValue({
      status: 'READY',
      prNumber,
      prUrl,
      prState: 'MERGED',
      prCiStatus: 'SUCCESS',
      prUpdatedAt: null,
      ratchetState: 'MERGED',
      ratchetEnabled: true,
      prHasMergeConflict: false,
    });
    emitMerge(prNumber, prUrl);
  };
  return {
    collector,
    acceptMerge,
    emitMerge,
    markIssueCompleted,
    signalIssueCompletion,
    getWorkspaceLinearContext,
    store,
    findById,
    findRatchetProjection,
    prSnapshotService,
    checkWorkspaceById,
    ratchetService,
    workspaceStateMachine,
  };
}

describe('Linear completion on PR merge', () => {
  it('completes the linked issue once across repeated merged snapshots', async () => {
    const { collector, acceptMerge, markIssueCompleted } = createHarness();
    try {
      acceptMerge();
      acceptMerge();
      await settleCompletions();
      expect(markIssueCompleted).toHaveBeenCalledExactlyOnceWith('test-key', 'issue-1');
    } finally {
      collector.stop();
    }
  });

  it('completes a seeded merged PR on its first poll', async () => {
    const { collector, acceptMerge, markIssueCompleted } = createHarness('MERGED');
    try {
      acceptMerge();
      await settleCompletions();
      expect(markIssueCompleted).toHaveBeenCalledExactlyOnceWith('test-key', 'issue-1');
    } finally {
      collector.stop();
    }
  });

  it('retries when Linear context becomes available on a later poll', async () => {
    const { collector, acceptMerge, markIssueCompleted, getWorkspaceLinearContext } =
      createHarness();
    getWorkspaceLinearContext.mockResolvedValueOnce(null);
    try {
      acceptMerge();
      await settleCompletions();
      expect(getWorkspaceLinearContext).toHaveBeenCalledTimes(1);
      expect(markIssueCompleted).not.toHaveBeenCalled();
      acceptMerge();
      await settleCompletions();
      expect(markIssueCompleted).toHaveBeenCalledExactlyOnceWith('test-key', 'issue-1');
    } finally {
      collector.stop();
    }
  });

  it.each(['reported', 'thrown'] as const)(
    'retries a %s completion failure on the next poll',
    async (failure) => {
      const { collector, acceptMerge, markIssueCompleted } = createHarness();
      if (failure === 'reported') {
        markIssueCompleted.mockResolvedValueOnce(false);
      } else {
        markIssueCompleted.mockRejectedValueOnce(new Error('Linear unavailable'));
      }
      try {
        acceptMerge();
        await settleCompletions();
        expect(markIssueCompleted).toHaveBeenCalledTimes(1);
        acceptMerge();
        await settleCompletions();
        expect(markIssueCompleted).toHaveBeenCalledTimes(2);
        acceptMerge();
        await settleCompletions();
        expect(markIssueCompleted).toHaveBeenCalledTimes(2);
      } finally {
        collector.stop();
      }
    }
  );

  it('suppresses repeated polls while completion is in flight and after it succeeds', async () => {
    const { collector, acceptMerge, markIssueCompleted } = createHarness();
    let resolve!: (completed: boolean) => void;
    markIssueCompleted.mockReturnValueOnce(
      new Promise<boolean>((done) => {
        resolve = done;
      })
    );
    try {
      acceptMerge();
      await settleCompletions();
      expect(markIssueCompleted).toHaveBeenCalledTimes(1);
      acceptMerge();
      await settleCompletions();
      expect(markIssueCompleted).toHaveBeenCalledTimes(1);
      resolve(true);
      await settleCompletions();
      acceptMerge();
      await settleCompletions();
      expect(markIssueCompleted).toHaveBeenCalledTimes(1);
    } finally {
      collector.stop();
    }
  });

  it('attempts completion again after the collector restarts', async () => {
    const { collector, acceptMerge, markIssueCompleted } = createHarness();
    try {
      acceptMerge();
      await settleCompletions();
      expect(markIssueCompleted).toHaveBeenCalledTimes(1);
      collector.stop();
      collector.start();
      acceptMerge();
      await settleCompletions();
      expect(markIssueCompleted).toHaveBeenCalledTimes(2);
    } finally {
      collector.stop();
    }
  });

  it('completes a newly linked merged PR after a previous merged PR', async () => {
    const { collector, acceptMerge, markIssueCompleted } = createHarness('MERGED');
    try {
      acceptMerge(8);
      acceptMerge(8);
      await settleCompletions();
      expect(markIssueCompleted).toHaveBeenCalledExactlyOnceWith('test-key', 'issue-1');
    } finally {
      collector.stop();
    }
  });
});

it.each(['switch', 'reopen'] as const)(
  'immediately observes an authoritative PR %s from an association event',
  async (change) => {
    const { collector, findById, prSnapshotService, checkWorkspaceById, store } = createHarness(
      change === 'reopen' ? 'CLOSED' : 'OPEN'
    );
    const prNumber = change === 'switch' ? 8 : 7;
    findById.mockResolvedValue({
      status: 'READY',
      prNumber,
      prUrl: `https://github.com/org/repo/pull/${prNumber}`,
      prState: 'OPEN',
      prCiStatus: 'FAILURE',
      prUpdatedAt: null,
      ratchetState: 'CI_FAILED',
      ratchetEnabled: true,
      prHasMergeConflict: false,
    });
    const checkRequested = Promise.withResolvers<void>();
    checkWorkspaceById.mockImplementationOnce(() => {
      checkRequested.resolve();
      return Promise.resolve(null);
    });
    try {
      prSnapshotService.emit(PR_SNAPSHOT_UPDATED, {
        workspaceId: 'ws-1',
        prId: 'selected',
        prNumber,
        prUrl: `https://github.com/org/repo/pull/${prNumber}`,
        prState: 'OPEN',
        prCiStatus: 'FAILURE',
        prReviewState: null,
      });
      await checkRequested.promise;
      expect(checkWorkspaceById).toHaveBeenCalledExactlyOnceWith('ws-1');
      expect(store.getByWorkspaceId('ws-1')).toMatchObject({ prNumber, prState: 'OPEN' });
    } finally {
      collector.stop();
    }
  }
);

it('refreshes primary and aggregate facts without completing an issue for a merged sibling', async () => {
  const { collector, emitMerge, markIssueCompleted, signalIssueCompletion, findById, store } =
    createHarness();
  findById.mockResolvedValue({
    status: 'READY',
    prUrl: 'https://github.com/org/repo/pull/7',
    prNumber: 7,
    prState: 'OPEN',
    prCiStatus: 'FAILURE',
    prUpdatedAt: new Date('2026-10-08T00:00:00Z'),
    ratchetState: 'CI_FAILED',
    ratchetEnabled: true,
    prHasMergeConflict: false,
    prMonitoring: {
      enabled: true,
      recipientSessionId: 'main',
      bindingRevision: 1,
      pauseReason: null,
      pendingEventCount: 1,
    },
  });
  try {
    emitMerge(8, 'https://github.com/org/repo/pull/8', 'merged-sibling');
    expect(store.getByWorkspaceId('ws-1')?.prNumber).toBe(7);
    await vi.waitFor(() => expect(store.getByWorkspaceId('ws-1')?.prCiStatus).toBe('FAILURE'));
    expect(store.getByWorkspaceId('ws-1')).toMatchObject({
      prState: 'OPEN',
      prNumber: 7,
      ratchetState: 'CI_FAILED',
    });
    expect(markIssueCompleted).not.toHaveBeenCalled();
    findById.mockResolvedValue({
      status: 'READY',
      prUrl: 'https://github.com/org/repo/pull/7',
      prNumber: 7,
      prState: 'MERGED',
      prCiStatus: 'SUCCESS',
      prUpdatedAt: null,
      ratchetState: 'MERGED',
      ratchetEnabled: true,
      prHasMergeConflict: false,
    });
    const completionRequested = signalIssueCompletion();
    emitMerge(7, 'https://github.com/org/repo/pull/7', 'last-open-pr');
    await completionRequested;
    expect(markIssueCompleted).toHaveBeenCalledExactlyOnceWith('test-key', 'issue-1');
  } finally {
    collector.stop();
  }
});
it('keeps the authoritative primary when a second association is attached', async () => {
  const { collector, findById, store, prSnapshotService } = createHarness();
  findById.mockResolvedValue({
    status: 'READY',
    prUrl: 'https://github.com/org/repo/pull/7',
    prNumber: 7,
    prState: 'OPEN',
    prCiStatus: 'FAILURE',
    prUpdatedAt: null,
    ratchetState: 'CI_FAILED',
    ratchetEnabled: true,
    prHasMergeConflict: false,
  });
  try {
    prSnapshotService.emit(PR_URL_ATTACHED, {
      workspaceId: 'ws-1',
      prId: 'new-sibling',
      prUrl: 'https://github.com/org/repo/pull/8',
    });
    expect(store.getByWorkspaceId('ws-1')?.prUrl).toBe('https://github.com/org/repo/pull/7');
    await vi.waitFor(() => expect(store.getByWorkspaceId('ws-1')?.prCiStatus).toBe('FAILURE'));
    expect(store.getByWorkspaceId('ws-1')?.prNumber).toBe(7);
  } finally {
    collector.stop();
  }
});

it('completes an association-aware merge after its final open sibling is detached', async () => {
  const {
    collector,
    emitMerge,
    markIssueCompleted,
    signalIssueCompletion,
    findById,
    store,
    prSnapshotService,
  } = createHarness();
  const projection = {
    status: 'READY',
    prUrl: 'https://github.com/org/repo/pull/7',
    prNumber: 7,
    prCiStatus: 'SUCCESS',
    prUpdatedAt: null,
    ratchetEnabled: true,
    prHasMergeConflict: false,
  };
  findById.mockResolvedValue({ ...projection, prState: 'OPEN', ratchetState: 'READY' });
  try {
    emitMerge(7, projection.prUrl, 'merged-association');
    await vi.waitFor(() => expect(store.getByWorkspaceId('ws-1')?.prCiStatus).toBe('SUCCESS'));
    expect(markIssueCompleted).not.toHaveBeenCalled();
    findById.mockResolvedValue({ ...projection, prState: 'MERGED', ratchetState: 'MERGED' });
    const completionRequested = signalIssueCompletion();
    prSnapshotService.emit(PR_DETACHED, { workspaceId: 'ws-1', prId: 'open-sibling' });
    await completionRequested;
    expect(markIssueCompleted).toHaveBeenCalledExactlyOnceWith('test-key', 'issue-1');
    expect(store.getByWorkspaceId('ws-1')?.prState).toBe('MERGED');
  } finally {
    collector.stop();
  }
});

it('shares PR and monitoring freshness without a broad workspace read or repeated PR effects', async () => {
  const {
    collector,
    findById,
    findRatchetProjection,
    prSnapshotService,
    ratchetService,
    checkWorkspaceById,
    markIssueCompleted,
    store,
  } = createHarness();
  let resolveRead!: (value: unknown) => void;
  const projection = {
    status: 'READY',
    prNumber: 8,
    prUrl: 'https://github.com/org/repo/pull/8',
    prState: 'OPEN',
    prCiStatus: 'FAILURE',
    prUpdatedAt: null,
    ratchetState: 'CI_FAILED',
    ratchetEnabled: true,
    prHasMergeConflict: false,
  };
  findById.mockRejectedValue(new Error('broad workspace reads are forbidden'));
  findRatchetProjection
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      })
    )
    .mockResolvedValueOnce(projection)
    .mockResolvedValue(projection);
  checkWorkspaceById.mockImplementationOnce(() => {
    ratchetService.emit('ratchet_dispatch_changed', { workspaceId: 'ws-1' });
    return Promise.resolve(null);
  });
  try {
    prSnapshotService.emit(PR_SNAPSHOT_UPDATED, {
      workspaceId: 'ws-1',
      prId: 'selected',
      prNumber: 8,
      prState: 'OPEN',
      prCiStatus: 'FAILURE',
      prReviewState: null,
    });
    ratchetService.emit('ratchet_dispatch_changed', { workspaceId: 'ws-1' });
    expect(findRatchetProjection).toHaveBeenCalledTimes(1);
    resolveRead({ ...projection, prNumber: 99 });
    await settleCompletions();
    expect(findRatchetProjection).toHaveBeenCalledTimes(3);
    expect(store.getByWorkspaceId('ws-1')).toMatchObject({ prNumber: 8, prState: 'OPEN' });
    expect(checkWorkspaceById).toHaveBeenCalledExactlyOnceWith('ws-1');
    expect(markIssueCompleted).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();

    findRatchetProjection.mockResolvedValue({ ...projection, prNumber: 9, prState: 'MERGED' });
    ratchetService.emit('ratchet_dispatch_changed', { workspaceId: 'ws-1' });
    await vi.waitFor(() => expect(store.getByWorkspaceId('ws-1')?.prState).toBe('MERGED'));
    expect(checkWorkspaceById).toHaveBeenCalledTimes(1);
    expect(markIssueCompleted).not.toHaveBeenCalled();
    expect(findRatchetProjection).toHaveBeenCalledTimes(4);
  } finally {
    collector.stop();
  }
});

it('uses the accepted association projection for Linear completion without another read', async () => {
  const {
    collector,
    emitMerge,
    findRatchetProjection,
    findById,
    markIssueCompleted,
    signalIssueCompletion,
  } = createHarness();
  findById.mockRejectedValue(new Error('broad workspace reads are forbidden'));
  findRatchetProjection.mockResolvedValue({
    status: 'READY',
    prNumber: 7,
    prUrl: 'https://github.com/org/repo/pull/7',
    prState: 'MERGED',
    prCiStatus: 'SUCCESS',
    prUpdatedAt: null,
    ratchetState: 'MERGED',
    ratchetEnabled: true,
    prHasMergeConflict: false,
  });
  try {
    const completionRequested = signalIssueCompletion();
    emitMerge(7, 'https://github.com/org/repo/pull/7', 'selected');
    await completionRequested;
    expect(markIssueCompleted).toHaveBeenCalledTimes(1);
    expect(findRatchetProjection).toHaveBeenCalledTimes(1);
    expect(findById).not.toHaveBeenCalled();
  } finally {
    collector.stop();
  }
});

it.each(['ARCHIVED', 'STOPPED'] as const)(
  'discards mixed PR and monitoring effects after %s',
  async (lifecycle) => {
    const {
      collector,
      emitMerge,
      findRatchetProjection,
      prSnapshotService,
      ratchetService,
      checkWorkspaceById,
      markIssueCompleted,
      store,
      workspaceStateMachine,
    } = createHarness();
    let resolveRead!: (value: unknown) => void;
    findRatchetProjection.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      })
    );
    try {
      emitMerge(8, 'https://github.com/org/repo/pull/8', 'selected');
      ratchetService.emit('ratchet_dispatch_changed', { workspaceId: 'ws-1' });
      if (lifecycle === 'ARCHIVED') {
        workspaceStateMachine.emit('workspace_state_changed', {
          workspaceId: 'ws-1',
          fromStatus: 'READY',
          toStatus: 'ARCHIVED',
        });
      } else {
        collector.stop();
      }
      resolveRead({
        status: 'READY',
        prNumber: 8,
        prUrl: 'https://github.com/org/repo/pull/8',
        prState: 'MERGED',
        prCiStatus: 'SUCCESS',
        prUpdatedAt: null,
        ratchetState: 'MERGED',
        ratchetEnabled: true,
        prHasMergeConflict: false,
      });
      await settleCompletions();
      expect(checkWorkspaceById).not.toHaveBeenCalled();
      expect(markIssueCompleted).not.toHaveBeenCalled();
      expect(findRatchetProjection).toHaveBeenCalledTimes(1);
      if (lifecycle === 'ARCHIVED') {
        expect(store.getByWorkspaceId('ws-1')).toBeUndefined();
      } else {
        expect(store.getByWorkspaceId('ws-1')?.prNumber).toBe(7);
      }
      expect(prSnapshotService.listenerCount(PR_SNAPSHOT_UPDATED)).toBe(
        lifecycle === 'STOPPED' ? 0 : 1
      );
    } finally {
      collector.stop();
    }
  }
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// Drain the projection and completion promise continuations after releasing any
// gates. Both are backed by in-memory mocks, with no I/O left to schedule work.
async function settleCompletions() {
  await nextTurn();
}

describe.each(['removal', 'restart'] as const)('Linear completion after %s', (cleanup) => {
  function clearTracking(collector: ReturnType<typeof createHarness>['collector']) {
    if (cleanup === 'removal') {
      collector.removeWorkspace('ws-1');
    } else {
      collector.stop();
      collector.start();
    }
  }

  it('clears a successful completion so the same PR can be attempted again', async () => {
    const { collector, acceptMerge, markIssueCompleted } = createHarness();
    try {
      acceptMerge();
      await settleCompletions();
      expect(markIssueCompleted).toHaveBeenCalledTimes(1);
      clearTracking(collector);
      acceptMerge();
      await settleCompletions();
      expect(markIssueCompleted).toHaveBeenCalledTimes(2);
    } finally {
      collector.stop();
    }
  });

  it.each(['false', 'throw'] as const)(
    'fences a late %s finalization from a new running attempt',
    async (result) => {
      const { collector, acceptMerge, markIssueCompleted } = createHarness();
      const first = deferred<boolean>();
      const second = deferred<boolean>();
      markIssueCompleted.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      try {
        acceptMerge();
        await settleCompletions();
        expect(markIssueCompleted).toHaveBeenCalledTimes(1);
        clearTracking(collector);
        acceptMerge();
        await settleCompletions();
        expect(markIssueCompleted).toHaveBeenCalledTimes(2);
        if (result === 'false') {
          first.resolve(false);
        } else {
          first.reject(new Error('late failure'));
        }
        await settleCompletions();
        acceptMerge();
        await settleCompletions();
        expect(markIssueCompleted).toHaveBeenCalledTimes(2);
        second.resolve(true);
        await settleCompletions();
        acceptMerge();
        await settleCompletions();
        expect(markIssueCompleted).toHaveBeenCalledTimes(2);
      } finally {
        collector.stop();
      }
    }
  );

  it('does not restore cleared tracking when admitted work succeeds later', async () => {
    const { collector, acceptMerge, markIssueCompleted } = createHarness();
    const first = deferred<boolean>();
    markIssueCompleted.mockReturnValueOnce(first.promise);
    try {
      acceptMerge();
      await settleCompletions();
      expect(markIssueCompleted).toHaveBeenCalledTimes(1);
      clearTracking(collector);
      first.resolve(true);
      await settleCompletions();
      acceptMerge();
      await settleCompletions();
      expect(markIssueCompleted).toHaveBeenCalledTimes(2);
    } finally {
      collector.stop();
    }
  });

  it('allows an admitted context lookup to continue after tracking cleanup', async () => {
    const { collector, acceptMerge, getWorkspaceLinearContext, markIssueCompleted } =
      createHarness();
    const context = deferred<{ apiKey: string; linearIssueId: string }>();
    getWorkspaceLinearContext.mockReturnValueOnce(context.promise);
    try {
      acceptMerge();
      await settleCompletions();
      expect(getWorkspaceLinearContext).toHaveBeenCalledTimes(1);
      clearTracking(collector);
      context.resolve({ apiKey: 'test-key', linearIssueId: 'issue-1' });
      await settleCompletions();
      expect(markIssueCompleted).toHaveBeenCalledExactlyOnceWith('test-key', 'issue-1');
      acceptMerge();
      await settleCompletions();
      expect(markIssueCompleted).toHaveBeenCalledTimes(2);
    } finally {
      collector.stop();
    }
  });
});

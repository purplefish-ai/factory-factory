import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { PR_DETACHED, PR_SNAPSHOT_UPDATED } from '@/backend/services/github';
import { deriveWorkspaceFlowState, WorkspaceSnapshotStore } from '@/backend/services/workspace';
import { deriveWorkspaceSidebarStatus } from '@/shared/core';
import { createEventCollectorOrchestrator } from './event-collector.orchestrator';

function createHarness(prState: 'OPEN' | 'MERGED' | null = 'OPEN') {
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
  const getWorkspaceLinearContext = vi
    .fn()
    .mockResolvedValue({ apiKey: 'test-key', linearIssueId: 'issue-1' });
  const findRatchetProjection = vi.fn().mockResolvedValue(null);
  const collector = createEventCollectorOrchestrator({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    getWorkspaceLinearContext,
    linearStateSyncService: { markIssueCompleted },
    prSnapshotService,
    prFetchCoordinator: { removeWorkspace: vi.fn() },
    ratchetService: Object.assign(new EventEmitter(), {
      checkWorkspaceById: vi.fn().mockResolvedValue(null),
    }),
    runScriptStateMachine: new EventEmitter(),
    workspaceAutoIterationService: new EventEmitter(),
    sessionDomainService: new EventEmitter(),
    workspaceActivityService: Object.assign(new EventEmitter(), { clearWorkspace: vi.fn() }),
    workspaceStateMachine: new EventEmitter(),
    workspaceDataService: { findRatchetProjection },
    workspaceSnapshotStore: store,
  } as never);
  collector.start();
  const emitMerge = (
    prNumber = 7,
    prUrl: string | null = `https://github.com/org/repo/pull/${prNumber}`
  ) =>
    prSnapshotService.emit(PR_SNAPSHOT_UPDATED, {
      workspaceId: 'ws-1',
      prNumber,
      prState: 'MERGED',
      prCiStatus: 'SUCCESS',
      prReviewState: null,
      ...(prUrl === null ? {} : { prUrl }),
    });
  return {
    collector,
    emitMerge,
    markIssueCompleted,
    getWorkspaceLinearContext,
    findRatchetProjection,
    prSnapshotService,
  };
}

describe('Linear completion on PR merge', () => {
  it.each(['CLOSED', 'DETACHED'])(
    'retries deferred completion when the last sibling is %s',
    async (transition) => {
      const { collector, emitMerge, markIssueCompleted, findRatchetProjection, prSnapshotService } =
        createHarness();
      try {
        findRatchetProjection.mockResolvedValue({
          status: 'READY',
          prSummary: { hasNonterminal: true },
        });
        emitMerge();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(markIssueCompleted).not.toHaveBeenCalled();
        findRatchetProjection.mockResolvedValue({
          status: 'READY',
          prSummary: { hasNonterminal: false },
        });
        if (transition === 'DETACHED') {
          prSnapshotService.emit(PR_DETACHED, { workspaceId: 'ws-1', prId: 'b' });
        } else {
          prSnapshotService.emit(PR_SNAPSHOT_UPDATED, {
            workspaceId: 'ws-1',
            prId: 'b',
            prNumber: 8,
            prState: 'CLOSED',
            prCiStatus: 'SUCCESS',
            prReviewState: null,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(markIssueCompleted).toHaveBeenCalledExactlyOnceWith('test-key', 'issue-1');
      } finally {
        collector.stop();
      }
    }
  );
  it.each(['CLOSED', 'DETACHED'])(
    'retries a %s transition during a stale projection read',
    async (transition) => {
      const { collector, emitMerge, markIssueCompleted, findRatchetProjection, prSnapshotService } =
        createHarness();
      let resolveProjection!: (value: unknown) => void;
      findRatchetProjection.mockResolvedValueOnce(null).mockReturnValueOnce(
        new Promise((resolve) => {
          resolveProjection = resolve;
        })
      );
      try {
        emitMerge();
        findRatchetProjection.mockResolvedValue({
          status: 'READY',
          prSummary: { hasNonterminal: false },
        });
        if (transition === 'DETACHED') {
          prSnapshotService.emit(PR_DETACHED, { workspaceId: 'ws-1', prId: 'b' });
        } else {
          prSnapshotService.emit(PR_SNAPSHOT_UPDATED, {
            workspaceId: 'ws-1',
            prId: 'b',
            prNumber: 8,
            prState: 'CLOSED',
            prCiStatus: 'SUCCESS',
            prReviewState: null,
          });
        }
        resolveProjection({ status: 'READY', prSummary: { hasNonterminal: true } });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(markIssueCompleted).toHaveBeenCalledExactlyOnceWith('test-key', 'issue-1');
      } finally {
        collector.stop();
      }
    }
  );
  it.each([false, true])(
    'deduplicates unseeded ratchet and poller events (settled: %s)',
    async (settled) => {
      const { collector, emitMerge, markIssueCompleted } = createHarness(null);
      try {
        emitMerge(7, null);
        if (settled) {
          await vi.waitFor(() => expect(markIssueCompleted).toHaveBeenCalledTimes(1));
        }
        emitMerge();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(markIssueCompleted).toHaveBeenCalledExactlyOnceWith('test-key', 'issue-1');
      } finally {
        collector.stop();
      }
    }
  );

  it('distinguishes same-numbered PRs after learning an initially missing URL', async () => {
    const { collector, emitMerge, markIssueCompleted } = createHarness(null);
    try {
      emitMerge(7, null);
      emitMerge();
      emitMerge(7, 'https://github.com/org/other/pull/7');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(markIssueCompleted).toHaveBeenCalledTimes(2);
    } finally {
      collector.stop();
    }
  });

  it('distinguishes a newly linked same-numbered PR from a seeded ratchet completion', async () => {
    const { collector, emitMerge, markIssueCompleted } = createHarness();
    try {
      emitMerge(7, null);
      emitMerge(7, 'https://github.com/org/other/pull/7');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(markIssueCompleted).toHaveBeenCalledTimes(2);
    } finally {
      collector.stop();
    }
  });

  it('completes the linked issue once across repeated merged snapshots', async () => {
    const { collector, emitMerge, markIssueCompleted } = createHarness();
    try {
      emitMerge();
      emitMerge();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(markIssueCompleted).toHaveBeenCalledExactlyOnceWith('test-key', 'issue-1');
    } finally {
      collector.stop();
    }
  });

  it('completes a seeded merged PR on its first poll', async () => {
    const { collector, emitMerge, markIssueCompleted } = createHarness('MERGED');
    try {
      emitMerge();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(markIssueCompleted).toHaveBeenCalledExactlyOnceWith('test-key', 'issue-1');
    } finally {
      collector.stop();
    }
  });

  it('retries when Linear context becomes available on a later poll', async () => {
    const { collector, emitMerge, markIssueCompleted, getWorkspaceLinearContext } = createHarness();
    getWorkspaceLinearContext.mockResolvedValueOnce(null);
    try {
      emitMerge();
      await vi.waitFor(() => expect(getWorkspaceLinearContext).toHaveBeenCalledTimes(1));
      expect(markIssueCompleted).not.toHaveBeenCalled();
      emitMerge();
      await vi.waitFor(() =>
        expect(markIssueCompleted).toHaveBeenCalledExactlyOnceWith('test-key', 'issue-1')
      );
    } finally {
      collector.stop();
    }
  });

  it.each(['reported', 'thrown'] as const)(
    'retries a %s completion failure on the next poll',
    async (failure) => {
      const { collector, emitMerge, markIssueCompleted } = createHarness();
      if (failure === 'reported') {
        markIssueCompleted.mockResolvedValueOnce(false);
      } else {
        markIssueCompleted.mockRejectedValueOnce(new Error('Linear unavailable'));
      }
      try {
        emitMerge();
        await vi.waitFor(() => expect(markIssueCompleted).toHaveBeenCalledTimes(1));
        emitMerge();
        await vi.waitFor(() => expect(markIssueCompleted).toHaveBeenCalledTimes(2));
        emitMerge();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(markIssueCompleted).toHaveBeenCalledTimes(2);
      } finally {
        collector.stop();
      }
    }
  );

  it('suppresses repeated polls while completion is in flight and after it succeeds', async () => {
    const { collector, emitMerge, markIssueCompleted } = createHarness();
    let resolve!: (completed: boolean) => void;
    markIssueCompleted.mockReturnValueOnce(
      new Promise<boolean>((done) => {
        resolve = done;
      })
    );
    try {
      emitMerge();
      await vi.waitFor(() => expect(markIssueCompleted).toHaveBeenCalledTimes(1));
      emitMerge();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(markIssueCompleted).toHaveBeenCalledTimes(1);
      resolve(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      emitMerge();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(markIssueCompleted).toHaveBeenCalledTimes(1);
    } finally {
      collector.stop();
    }
  });

  it('attempts completion again after the collector restarts', async () => {
    const { collector, emitMerge, markIssueCompleted } = createHarness();
    try {
      emitMerge();
      await vi.waitFor(() => expect(markIssueCompleted).toHaveBeenCalledTimes(1));
      collector.stop();
      collector.start();
      emitMerge();
      await vi.waitFor(() => expect(markIssueCompleted).toHaveBeenCalledTimes(2));
    } finally {
      collector.stop();
    }
  });

  it('completes a newly linked merged PR after a previous merged PR', async () => {
    const { collector, emitMerge, markIssueCompleted } = createHarness('MERGED');
    try {
      emitMerge(8);
      emitMerge(8);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(markIssueCompleted).toHaveBeenCalledExactlyOnceWith('test-key', 'issue-1');
    } finally {
      collector.stop();
    }
  });
});

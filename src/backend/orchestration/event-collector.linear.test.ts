import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { PR_SNAPSHOT_UPDATED } from '@/backend/services/github';
import { deriveWorkspaceFlowState, WorkspaceSnapshotStore } from '@/backend/services/workspace';
import { deriveWorkspaceSidebarStatus } from '@/shared/core';
import { createEventCollectorOrchestrator } from './event-collector.orchestrator';

function createHarness(prState: 'OPEN' | 'MERGED' = 'OPEN') {
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
      status: 'READY',
      prState,
      prNumber: 7,
      prUrl: 'https://github.com/org/repo/pull/7',
    },
    'reconciliation',
    1
  );
  const prSnapshotService = new EventEmitter();
  const markIssueCompleted = vi.fn().mockResolvedValue(undefined);
  const collector = createEventCollectorOrchestrator({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    getWorkspaceLinearContext: vi
      .fn()
      .mockResolvedValue({ apiKey: 'test-key', linearIssueId: 'issue-1' }),
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
    workspaceDataService: { findRatchetProjection: vi.fn().mockResolvedValue(null) },
    workspaceSnapshotStore: store,
  } as never);
  collector.start();
  const emitMerge = (prNumber = 7) =>
    prSnapshotService.emit(PR_SNAPSHOT_UPDATED, {
      workspaceId: 'ws-1',
      prNumber,
      prState: 'MERGED',
      prCiStatus: 'SUCCESS',
      prReviewState: null,
      prUrl: `https://github.com/org/repo/pull/${prNumber}`,
    });
  return { collector, emitMerge, markIssueCompleted };
}

describe('Linear completion on PR merge', () => {
  it('completes the linked issue once across repeated merged snapshots', async () => {
    const { collector, emitMerge, markIssueCompleted } = createHarness();
    try {
      emitMerge();
      emitMerge();
      await Promise.resolve();
      expect(markIssueCompleted).toHaveBeenCalledExactlyOnceWith('test-key', 'issue-1');
    } finally {
      collector.stop();
    }
  });

  it('does not repeat completion for a seeded merged PR', async () => {
    const { collector, emitMerge, markIssueCompleted } = createHarness('MERGED');
    try {
      emitMerge();
      await Promise.resolve();
      expect(markIssueCompleted).not.toHaveBeenCalled();
    } finally {
      collector.stop();
    }
  });

  it('completes a newly linked merged PR after a previous merged PR', async () => {
    const { collector, emitMerge, markIssueCompleted } = createHarness('MERGED');
    try {
      emitMerge(8);
      emitMerge(8);
      await Promise.resolve();
      expect(markIssueCompleted).toHaveBeenCalledExactlyOnceWith('test-key', 'issue-1');
    } finally {
      collector.stop();
    }
  });
});

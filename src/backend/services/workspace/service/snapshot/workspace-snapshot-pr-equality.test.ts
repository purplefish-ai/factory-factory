import { expect, it, vi } from 'vitest';
import { deriveWorkspaceFlowState } from '@/backend/services/workspace';
import { deriveWorkspaceSidebarStatus } from '@/shared/core';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';
import { deriveWorkspacePRSummary } from '@/shared/workspace-pr-summary';
import { SNAPSHOT_CHANGED, WorkspaceSnapshotStore } from './workspace-snapshot-store.service';

it('suppresses identical PR collection reconciliations but publishes nested PR changes', () => {
  const store = new WorkspaceSnapshotStore();
  store.configure({
    deriveFlowState: (input) =>
      deriveWorkspaceFlowState({
        ...input,
        prUpdatedAt: input.prUpdatedAt ? new Date(input.prUpdatedAt) : null,
      }),
    deriveSidebarStatus: deriveWorkspaceSidebarStatus,
  });
  const pr: WorkspacePullRequest = {
    id: 'a',
    url: 'https://github.com/o/r/pull/1',
    number: 1,
    title: 'A',
    headRefName: 'feature',
    baseRefName: 'main',
    state: 'OPEN',
    reviewState: null,
    ciStatus: 'SUCCESS',
    hasMergeConflict: false,
    syncedAt: null,
    ratchet: {
      lastCheckedAt: null,
      dispatchOutcome: null,
      dispatchRetryCount: 0,
      dispatchStalled: false,
    },
  };
  const prs = [pr];
  const update = { projectId: 'p', prs, prSummary: deriveWorkspacePRSummary(prs, true) };
  store.upsert('w', update, 'reconciliation', 1);
  const changed = vi.fn();
  store.on(SNAPSHOT_CHANGED, changed);
  store.upsert('w', structuredClone(update), 'reconciliation', 2);
  expect(changed).not.toHaveBeenCalled();
  const next = structuredClone(update);
  next.prs[0]!.ratchet.dispatchRetryCount = 2;
  store.upsert('w', next, 'reconciliation', 3);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(store.getByWorkspaceId('w')?.prs?.[0]?.ratchet.dispatchRetryCount).toBe(2);
});

import { expect, it } from 'vitest';
import { deriveWorkspaceFlowState, WorkspaceSnapshotStore } from '@/backend/services/workspace';
import { deriveWorkspaceSidebarStatus } from '@/shared/core';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';
import { deriveWorkspacePRSummary } from '@/shared/workspace-pr-summary';
import { projectPrEvent } from './pr-event-projection';

const pr = (id: string, url: string, number: number): WorkspacePullRequest => ({
  id,
  url,
  number,
  title: id,
  headRefName: null,
  baseRefName: null,
  state: 'OPEN',
  reviewState: null,
  ciStatus: 'PENDING',
  hasMergeConflict: false,
  syncedAt: null,
  ratchet: {
    lastCheckedAt: null,
    dispatchOutcome: null,
    dispatchRetryCount: 0,
    dispatchStalled: false,
  },
});
function previous(prs: WorkspacePullRequest[]) {
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
    'w',
    { projectId: 'p', status: 'READY', prs, prSummary: deriveWorkspacePRSummary(prs, true) },
    'seed',
    1
  );
  return store.getByWorkspaceId('w')!;
}
const event = {
  workspaceId: 'w',
  prNumber: 1,
  prState: 'MERGED',
  prCiStatus: 'SUCCESS',
  prReviewState: null,
};
it.each([true, false])(
  'resolves legacy observations to their PR without a stable ID (URL: %s)',
  (withUrl) => {
    const a = pr('a', 'https://github.com/o/r/pull/1', 1),
      b = pr('b', 'https://github.com/o/r/pull/2', 2);
    const update = projectPrEvent(previous([a, b]), {
      ...event,
      ...(withUrl ? { prUrl: a.url } : {}),
    });
    expect(update.prs?.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: 'a', state: 'MERGED' },
      { id: 'b', state: 'OPEN' },
    ]);
    expect(update.prSummary).toMatchObject({ totalCount: 2, hasNonterminal: true });
    expect(update.prUrl).toBeNull();
  }
);
it('does not assign ambiguous PR numbers across repositories', () => {
  const a = pr('a', 'https://github.com/o/r/pull/1', 1),
    b = pr('b', 'https://github.com/o/other/pull/1', 1);
  expect(projectPrEvent(previous([a, b]), event)).toEqual({});
});
it('does not replace collection identity from an unmatched legacy URL', () => {
  expect(
    projectPrEvent(previous([pr('a', 'https://github.com/o/r/pull/1', 1)]), {
      ...event,
      prUrl: 'https://github.com/o/other/pull/1',
    })
  ).toEqual({});
});

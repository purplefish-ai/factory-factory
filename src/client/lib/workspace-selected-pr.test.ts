import { expect, it } from 'vitest';
import { getWorkspaceSelectedPR, getWorkspacePRReviewTarget } from './workspace-selected-pr';
import { createOptimisticWorkspaceSummary } from './workspace-summary';

it('uses selected facts for links without borrowing aggregate CI or review state', () => {
  const base = createOptimisticWorkspaceSummary({
    id: 'w',
    projectId: 'p',
    name: 'W',
    ratchetEnabled: true,
  });
  const a = {
    id: 'a',
    url: 'https://github.com/o/r/pull/1',
    number: 1,
    title: null,
    headRefName: null,
    baseRefName: null,
    state: 'APPROVED' as const,
    reviewState: 'APPROVED',
    ciStatus: 'SUCCESS' as const,
    hasMergeConflict: false,
    syncedAt: null,
  };
  const b = {
    ...a,
    id: 'b',
    number: 2,
    state: 'CHANGES_REQUESTED' as const,
    reviewState: 'CHANGES_REQUESTED',
    ciStatus: 'FAILURE' as const,
  };
  expect(
    getWorkspaceSelectedPR({
      ...base,
      prs: [b, a],
      prUrl: b.url,
      prNumber: 2,
      prState: 'OPEN',
      prCiStatus: 'FAILURE',
    })
  ).toEqual(a);
  expect(getWorkspaceSelectedPR(base)).toBeNull();
  const { selectedPr: _selected, selectedPrId: _id, prs: _prs, ...legacy } = base;
  expect(
    getWorkspaceSelectedPR({
      ...legacy,
      prUrl: a.url,
      prNumber: 1,
      prState: 'APPROVED',
      prCiStatus: 'SUCCESS',
    })
  ).toMatchObject({ url: a.url, number: 1, state: 'APPROVED', ciStatus: 'SUCCESS' });
});

it('honors an explicitly empty collection over stale selected facts and scalar aliases', () => {
  const selectedPr = {
    id: 'detached',
    url: 'https://github.com/o/r/pull/1',
    number: 1,
    title: null,
    headRefName: null,
    baseRefName: null,
    state: 'OPEN' as const,
    reviewState: null,
    ciStatus: 'SUCCESS' as const,
    hasMergeConflict: false,
    syncedAt: null,
  };
  expect(
    getWorkspaceSelectedPR({ id: 'w', prs: [], selectedPr, prUrl: selectedPr.url })
  ).toBeNull();
  expect(getWorkspaceSelectedPR({ id: 'w', prs: [], prUrl: selectedPr.url })).toBeNull();
});

it('resolves review association IDs only for persisted identities', () => {
  const legacy = {
    id: 'w',
    prUrl: 'https://github.com/o/r/pull/1',
    prNumber: 1,
    prState: 'OPEN' as const,
  };
  const target = getWorkspacePRReviewTarget(legacy);
  expect(target).toMatchObject({ associationId: null, pr: { id: 'legacy-pr-w' } });
  const pr = target.pr!;
  expect(getWorkspacePRReviewTarget({ id: 'w', prs: [pr] }).associationId).toBeNull();
  expect(
    getWorkspacePRReviewTarget({ id: 'w', prs: [{ ...pr, id: 'display-only' }] }).associationId
  ).toBeNull();
  const { identitySource: _source, ...persisted } = pr;
  expect(
    getWorkspacePRReviewTarget({ id: 'w', prs: [{ ...persisted, id: 'persisted' }] }).associationId
  ).toBe('persisted');
  expect(
    getWorkspacePRReviewTarget({ id: 'w', prs: [{ ...persisted, id: 'legacy-pr-w' }] })
      .associationId
  ).toBe('legacy-pr-w');
});

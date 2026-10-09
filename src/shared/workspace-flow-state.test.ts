import { expect, it } from 'vitest';
import { deriveWorkspaceFlowState } from './workspace-flow-state';
import { deriveWorkspacePRSummary } from './workspace-pr-summary';

it('uses the aggregate PR observation instead of stale legacy merged fields', () => {
  const summary = deriveWorkspacePRSummary(
    [
      {
        id: 'open-pr',
        url: 'https://github.com/o/r/pull/2',
        number: 2,
        title: null,
        headRefName: null,
        baseRefName: null,
        state: 'OPEN',
        ciStatus: 'PENDING',
        reviewState: null,
        hasMergeConflict: false,
        syncedAt: null,
      },
    ],
    true
  );
  expect(
    deriveWorkspaceFlowState({
      prSummary: summary,
      prUrl: null,
      prState: 'MERGED',
      prCiStatus: 'SUCCESS',
      ratchetState: 'MERGED',
      prUpdatedAt: null,
      ratchetEnabled: true,
    })
  ).toMatchObject({
    phase: 'CI_WAIT',
    ciObservation: 'CHECKS_PENDING',
    hasActivePr: true,
    shouldAnimateRatchetButton: true,
  });
});

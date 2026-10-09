import { expect, it } from 'vitest';
import type { WorkspacePullRequest } from './workspace-pr';
import { deriveWorkspacePRSummary } from './workspace-pr-summary';

const pr = (fields: Partial<WorkspacePullRequest>): WorkspacePullRequest => ({
  id: 'a',
  url: 'https://github.com/o/r/pull/1',
  number: 1,
  title: null,
  headRefName: null,
  baseRefName: null,
  state: 'OPEN',
  reviewState: null,
  ciStatus: 'SUCCESS',
  hasMergeConflict: false,
  syncedAt: null,
  ...fields,
});
it.each([
  [[pr({ state: 'MERGED' }), pr({ ciStatus: 'FAILURE' })], 'OPEN', 'FAILURE', 'CI_FAILED'],
  [[pr({ state: 'CLOSED' }), pr({ ciStatus: 'PENDING' })], 'OPEN', 'PENDING', 'CI_RUNNING'],
  [[pr({ state: 'NONE' }), pr({ state: 'MERGED' })], 'OPEN', 'UNKNOWN', 'CI_RUNNING'],
  [[pr({ ciStatus: 'FAILURE' }), pr({ ciStatus: 'PENDING' })], 'OPEN', 'FAILURE', 'CI_FAILED'],
  [
    [pr({ hasMergeConflict: true }), pr({ ciStatus: 'PENDING' })],
    'OPEN',
    'PENDING',
    'MERGE_CONFLICT',
  ],
  [[pr({ reviewState: 'CHANGES_REQUESTED' }), pr({})], 'OPEN', 'SUCCESS', 'REVIEW_PENDING'],
  [[pr({ state: 'MERGED' }), pr({ state: 'CLOSED' })], 'CLOSED', 'UNKNOWN', 'IDLE'],
  [[pr({ state: 'MERGED' }), pr({ state: 'MERGED' })], 'MERGED', 'UNKNOWN', 'MERGED'],
  [[], 'NONE', 'UNKNOWN', 'IDLE'],
] as const)('aggregates every PR (%#)', (prs, state, ciStatus, ratchetState) => {
  expect(deriveWorkspacePRSummary(prs, true)).toMatchObject({ state, ciStatus, ratchetState });
});
it('disables monitoring without hiding GitHub failures', () => {
  expect(deriveWorkspacePRSummary([pr({ ciStatus: 'FAILURE' })], false)).toMatchObject({
    state: 'OPEN',
    ciStatus: 'FAILURE',
    ratchetState: 'IDLE',
  });
});

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
  ratchet: {
    lastCheckedAt: null,
    dispatchOutcome: null,
    dispatchRetryCount: 0,
    dispatchStalled: false,
  },
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
  [[pr({ state: 'MERGED' }), pr({ state: 'CLOSED' })], 'MERGED', 'UNKNOWN', 'MERGED'],
  [[], 'NONE', 'UNKNOWN', 'IDLE'],
] as const)('aggregates every PR (%#)', (prs, state, ciStatus, ratchetState) => {
  expect(deriveWorkspacePRSummary(prs, true)).toMatchObject({ state, ciStatus, ratchetState });
});
it('keeps pending siblings and active fixers out of stalled state', () => {
  const stalled = pr({
    ciStatus: 'FAILURE',
    ratchet: {
      lastCheckedAt: null,
      dispatchOutcome: 'DIED',
      dispatchRetryCount: 3,
      dispatchStalled: true,
    },
  });
  expect(deriveWorkspacePRSummary([stalled], true).dispatchStalled).toBe(true);
  expect(
    deriveWorkspacePRSummary([stalled, pr({ ciStatus: 'PENDING' })], true).dispatchStalled
  ).toBe(false);
  expect(
    deriveWorkspacePRSummary([stalled, pr({ ciStatus: 'FAILURE' })], true).dispatchStalled
  ).toBe(false);
  expect(deriveWorkspacePRSummary([stalled], false).ratchetState).toBe('IDLE');
});

it('preserves exhausted comment-only work and defers stalls while siblings wait', () => {
  const stalled = pr({
    ratchet: {
      lastCheckedAt: null,
      dispatchOutcome: 'DIED',
      dispatchRetryCount: 3,
      dispatchStalled: true,
    },
  });
  expect(deriveWorkspacePRSummary([stalled], true).dispatchStalled).toBe(true);
  expect(
    deriveWorkspacePRSummary([stalled, pr({ ciStatus: 'PENDING' })], true).dispatchStalled
  ).toBe(false);
  expect(
    deriveWorkspacePRSummary([stalled, pr({ ciStatus: 'FAILURE' })], true).dispatchStalled
  ).toBe(false);
});

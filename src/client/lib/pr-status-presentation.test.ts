import { describe, expect, it } from 'vitest';
import type { GitHubStatusCheck, MergeStateStatus } from '@/shared/github-types';
import {
  getCheckOutcome,
  getCheckPresentation,
  getMergeStatePresentation,
  getReviewDecisionPresentation,
  getReviewStatePresentation,
  humanizeGitHubEnum,
} from './pr-status-presentation';

function check(
  status: GitHubStatusCheck['status'],
  conclusion: GitHubStatusCheck['conclusion'] = null
): GitHubStatusCheck {
  return { __typename: 'CheckRun', name: 'ci', status, conclusion };
}

describe('humanizeGitHubEnum', () => {
  it.each([
    ['CHANGES_REQUESTED', 'Changes requested'],
    ['TIMED_OUT', 'Timed out'],
    ['SUCCESS', 'Success'],
  ])('turns %s into %s', (value, expected) => {
    expect(humanizeGitHubEnum(value)).toBe(expected);
  });
});

describe('review presentation', () => {
  it.each([
    ['APPROVED', 'success', 'Approved'],
    ['CHANGES_REQUESTED', 'danger', 'Changes requested'],
    ['REVIEW_REQUIRED', 'attention', 'Review required'],
    [null, 'neutral', 'Pending'],
  ] as const)('presents the %s decision', (decision, tone, label) => {
    expect(getReviewDecisionPresentation(decision)).toEqual({ tone, label });
  });

  it.each([
    ['APPROVED', 'success', 'Approved'],
    ['CHANGES_REQUESTED', 'danger', 'Changes requested'],
    ['COMMENTED', 'neutral', 'Commented'],
    ['DISMISSED', 'neutral', 'Dismissed'],
    ['PENDING', 'neutral', 'Pending'],
  ] as const)('presents a %s review', (state, tone, label) => {
    expect(getReviewStatePresentation(state)).toEqual({ tone, label });
  });
});

describe('getMergeStatePresentation', () => {
  it.each([
    ['CLEAN', 'success', 'Ready to merge'],
    ['HAS_HOOKS', 'success', 'Ready to merge'],
    ['UNSTABLE', 'warning', 'Checks not passing'],
    ['BEHIND', 'warning', 'Behind base branch'],
    ['BLOCKED', 'attention', 'Blocked'],
    ['DIRTY', 'danger', 'Merge conflicts'],
    ['DRAFT', 'neutral', 'Draft'],
    ['UNKNOWN', 'neutral', 'Checking mergeability'],
  ] as const satisfies readonly (readonly [MergeStateStatus, string, string])[])(
    'presents %s',
    (status, tone, label) => {
      expect(getMergeStatePresentation(status)).toEqual({ tone, label });
    }
  );

  it('never shows the raw enum', () => {
    for (const status of ['BLOCKED', 'DIRTY', 'UNKNOWN'] as const) {
      expect(getMergeStatePresentation(status).label).not.toBe(status);
    }
  });
});

describe('check presentation', () => {
  it('classifies checks like the PR-level CI status', () => {
    expect(getCheckOutcome(check('COMPLETED', 'SUCCESS'))).toBe('passed');
    expect(getCheckOutcome(check('COMPLETED', 'NEUTRAL'))).toBe('passed');
    expect(getCheckOutcome(check('COMPLETED', 'CANCELLED'))).toBe('failed');
    expect(getCheckOutcome(check('COMPLETED', 'SKIPPED'))).toBe('skipped');
    expect(getCheckOutcome(check('QUEUED'))).toBe('pending');
  });

  it('labels progress and conclusions without raw enums', () => {
    expect(getCheckPresentation(check('IN_PROGRESS'))).toEqual({
      tone: 'waiting',
      label: 'Running',
    });
    expect(getCheckPresentation(check('QUEUED'))).toEqual({ tone: 'waiting', label: 'Queued' });
    expect(getCheckPresentation(check('COMPLETED', 'SUCCESS'))).toEqual({
      tone: 'success',
      label: 'Success',
    });
    expect(getCheckPresentation(check('COMPLETED', 'ACTION_REQUIRED'))).toEqual({
      tone: 'danger',
      label: 'Action required',
    });
    expect(getCheckPresentation(check('COMPLETED', 'SKIPPED'))).toEqual({
      tone: 'neutral',
      label: 'Skipped',
    });
  });
});

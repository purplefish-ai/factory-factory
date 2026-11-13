import { describe, expect, it } from 'vitest';
import {
  followUpFixes,
  type MergedPullRequest,
  mergedPullRequestListSchema,
  openToMergeHours,
  pullRequestMetrics,
  referencedPullRequestNumbers,
  startsWithFixVerb,
} from './pull-requests';

function pullRequest(
  number: number,
  title: string,
  createdAt: string,
  mergedAt: string,
  body = ''
): MergedPullRequest {
  return { number, title, body, createdAt, mergedAt };
}

describe('merged pull request metrics', () => {
  it('measures open-to-merge hours', () => {
    expect(
      openToMergeHours([
        pullRequest(1, 'Add a', '2026-11-01T10:00:00Z', '2026-11-01T10:30:00Z'),
        pullRequest(2, 'Add b', '2026-11-01T10:00:00Z', '2026-11-01T12:00:00Z'),
      ])
    ).toEqual({ count: 2, median: 1.25, p90: 1.85 });
  });

  it('recognizes fix verbs at the start of a title', () => {
    expect(startsWithFixVerb('Fix sentence casing')).toBe(true);
    expect(startsWithFixVerb('fix(chat): stop flicker')).toBe(true);
    expect(startsWithFixVerb('Restore full access')).toBe(true);
    expect(startsWithFixVerb('Prevent repeated clicks')).toBe(true);
    expect(startsWithFixVerb('Fixture route for mobile')).toBe(false);
    expect(startsWithFixVerb('Add a fix button')).toBe(false);
  });

  it('extracts referenced pull request numbers', () => {
    expect(
      referencedPullRequestNumbers(
        'Follows #12 and https://github.com/o/r/pull/34. Not a&#39; entity or a/#56 path. #12 again.'
      )
    ).toEqual([12, 34]);
  });

  it('counts fix PRs that reference a PR merged in the previous 7 days', () => {
    const pullRequests = [
      pullRequest(10, 'Add feature', '2026-11-01T09:00:00Z', '2026-11-01T10:00:00Z'),
      pullRequest(11, 'Add old feature', '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z'),
      pullRequest(20, 'Fix feature', '2026-11-03T09:00:00Z', '2026-11-03T10:00:00Z', 'After #10.'),
      pullRequest(
        21,
        'Fix old feature',
        '2026-11-03T09:00:00Z',
        '2026-11-03T11:00:00Z',
        'After #11.'
      ),
      pullRequest(22, 'Fix itself', '2026-11-03T09:00:00Z', '2026-11-03T12:00:00Z', 'See #22.'),
      pullRequest(23, 'Add more', '2026-11-03T09:00:00Z', '2026-11-03T13:00:00Z', 'After #10.'),
      pullRequest(24, 'Fix later work', '2026-11-03T09:00:00Z', '2026-11-03T14:00:00Z', '#25'),
      pullRequest(25, 'Add later work', '2026-11-04T09:00:00Z', '2026-11-04T10:00:00Z'),
    ];
    expect(followUpFixes(pullRequests)).toEqual({
      fixTitled: 4,
      referencingRecentMerge: 1,
      share: 0.125,
      numbers: [20],
    });
    expect(pullRequestMetrics(pullRequests)).toMatchObject({
      merged: 8,
      window: { from: '2026-10-01T10:00:00Z', to: '2026-11-04T10:00:00Z' },
    });
  });

  it('validates gh pr list JSON', () => {
    expect(
      mergedPullRequestListSchema.safeParse([
        { number: 1, title: 'x', body: '', createdAt: 'yesterday', mergedAt: 'today' },
      ]).success
    ).toBe(false);
  });
});

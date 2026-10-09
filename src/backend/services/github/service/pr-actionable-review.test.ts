import { describe, expect, it } from 'vitest';
import {
  buildReviewSummariesForPrompt,
  computeLatestReviewActivityAtMs,
} from './pr-actionable-review';

describe('buildReviewSummariesForPrompt', () => {
  it('includes actionable commented review bodies as prompt feedback', () => {
    const summaries = buildReviewSummariesForPrompt(
      {
        url: 'https://github.com/example/repo/pull/1',
        reviews: [
          {
            author: { login: 'cubic-dev-ai' },
            state: 'COMMENTED',
            body: 'Please fix the hydration edge case.',
            url: 'https://github.com/example/repo/pull/1#pullrequestreview-1',
          },
        ],
      },
      null,
      'ALL_REVIEW_FEEDBACK'
    );

    expect(summaries).toEqual([
      {
        author: 'cubic-dev-ai',
        body: 'Please fix the hydration edge case.',
        path: 'PR review',
        line: null,
        url: 'https://github.com/example/repo/pull/1#pullrequestreview-1',
      },
    ]);
  });

  it('ignores approvals, empty bodies, and the authenticated user', () => {
    const summaries = buildReviewSummariesForPrompt(
      {
        url: 'https://github.com/example/repo/pull/1',
        reviews: [
          {
            author: { login: 'reviewer' },
            state: 'APPROVED',
            body: 'Looks good.',
          },
          {
            author: { login: 'reviewer' },
            state: 'COMMENTED',
            body: '   ',
          },
          {
            author: { login: 'me' },
            state: 'CHANGES_REQUESTED',
            body: 'My own note.',
          },
        ],
      },
      'me',
      'CHANGES_REQUESTED'
    );

    expect(summaries).toEqual([]);
  });

  it('excludes stale changes-requested reviews after the same reviewer approves', () => {
    const summaries = buildReviewSummariesForPrompt(
      {
        url: 'https://github.com/example/repo/pull/1',
        reviews: [
          {
            submittedAt: '2026-01-01T00:00:00Z',
            author: { login: 'reviewer-a' },
            state: 'CHANGES_REQUESTED',
            body: 'A requests changes first',
          },
          {
            submittedAt: '2026-01-02T00:00:00Z',
            author: { login: 'reviewer-b' },
            state: 'CHANGES_REQUESTED',
            body: 'B requests changes',
          },
          {
            submittedAt: '2026-01-03T00:00:00Z',
            author: { login: 'reviewer-a' },
            state: 'APPROVED',
            body: '',
          },
        ],
      },
      null,
      'CHANGES_REQUESTED'
    );

    expect(summaries).toEqual([
      {
        author: 'reviewer-b',
        body: 'B requests changes',
        path: 'PR review',
        line: null,
        url: 'https://github.com/example/repo/pull/1',
      },
    ]);
  });

  it('excludes stale commented reviews after the same reviewer approves', () => {
    const summaries = buildReviewSummariesForPrompt(
      {
        url: 'https://github.com/example/repo/pull/1',
        reviews: [
          {
            submittedAt: '2026-01-02T00:00:00Z',
            author: { login: 'reviewer-a' },
            state: 'COMMENTED',
            body: 'Please fix the first-round issue',
          },
          {
            submittedAt: '2026-01-03T00:00:00Z',
            author: { login: 'reviewer-a' },
            state: 'APPROVED',
            body: '',
          },
        ],
      },
      null,
      'ALL_REVIEW_FEEDBACK'
    );

    expect(summaries).toEqual([]);
  });

  it('keeps changes-requested reviews when they are the reviewer latest state', () => {
    const summaries = buildReviewSummariesForPrompt(
      {
        url: 'https://github.com/example/repo/pull/1',
        reviews: [
          {
            chronologicalOrder: 0,
            author: { login: 'reviewer-a' },
            state: 'APPROVED',
            body: '',
          },
          {
            chronologicalOrder: 1,
            author: { login: 'reviewer-a' },
            state: 'CHANGES_REQUESTED',
            body: 'A found a later issue',
          },
        ],
      },
      null,
      'CHANGES_REQUESTED'
    );

    expect(summaries).toEqual([
      {
        author: 'reviewer-a',
        body: 'A found a later issue',
        path: 'PR review',
        line: null,
        url: 'https://github.com/example/repo/pull/1',
      },
    ]);
  });

  it('excludes stale changes-requested reviews when the reviewer approves then comments', () => {
    const summaries = buildReviewSummariesForPrompt(
      {
        url: 'https://github.com/example/repo/pull/1',
        reviews: [
          {
            submittedAt: '2026-01-01T00:00:00Z',
            author: { login: 'reviewer-a' },
            state: 'CHANGES_REQUESTED',
            body: 'Please fix the null check',
          },
          {
            submittedAt: '2026-01-02T00:00:00Z',
            author: { login: 'reviewer-a' },
            state: 'APPROVED',
            body: '',
          },
          {
            submittedAt: '2026-01-03T00:00:00Z',
            author: { login: 'reviewer-a' },
            state: 'COMMENTED',
            body: 'Thanks for the fix!',
          },
        ],
      },
      null,
      'ALL_REVIEW_FEEDBACK'
    );

    expect(summaries).toEqual([
      {
        author: 'reviewer-a',
        body: 'Thanks for the fix!',
        path: 'PR review',
        line: null,
        url: 'https://github.com/example/repo/pull/1',
      },
    ]);
  });

  it('keeps changes-requested reviews submitted after the reviewer last approved', () => {
    const summaries = buildReviewSummariesForPrompt(
      {
        url: 'https://github.com/example/repo/pull/1',
        reviews: [
          {
            submittedAt: '2026-01-01T00:00:00Z',
            author: { login: 'reviewer-a' },
            state: 'CHANGES_REQUESTED',
            body: 'First round of feedback',
          },
          {
            submittedAt: '2026-01-02T00:00:00Z',
            author: { login: 'reviewer-a' },
            state: 'APPROVED',
            body: '',
          },
          {
            submittedAt: '2026-01-03T00:00:00Z',
            author: { login: 'reviewer-a' },
            state: 'CHANGES_REQUESTED',
            body: 'Found a new issue after approving',
          },
        ],
      },
      null,
      'CHANGES_REQUESTED'
    );

    expect(summaries).toEqual([
      {
        author: 'reviewer-a',
        body: 'Found a new issue after approving',
        path: 'PR review',
        line: null,
        url: 'https://github.com/example/repo/pull/1',
      },
    ]);
  });

  it('uses submission time to filter reviews when GitHub returns them out of order', () => {
    const prDetails = {
      url: 'https://github.com/example/repo/pull/1',
      reviews: [
        {
          submittedAt: '2026-01-04T00:00:00Z',
          author: { login: 'reviewer-a' },
          state: 'COMMENTED',
          body: 'New feedback after approval',
        },
        {
          submittedAt: '2026-01-03T00:00:00Z',
          author: { login: 'reviewer-a' },
          state: 'APPROVED',
          body: '',
        },
        {
          submittedAt: '2026-01-02T00:00:00Z',
          author: { login: 'reviewer-a' },
          state: 'COMMENTED',
          body: 'Old feedback before approval',
        },
      ],
    };

    expect(buildReviewSummariesForPrompt(prDetails, null, 'ALL_REVIEW_FEEDBACK')).toEqual([
      {
        author: 'reviewer-a',
        body: 'New feedback after approval',
        path: 'PR review',
        line: null,
        url: 'https://github.com/example/repo/pull/1',
      },
    ]);
  });

  it('excludes commented review summaries in changes-requested mode', () => {
    const summaries = buildReviewSummariesForPrompt(
      {
        url: 'https://github.com/example/repo/pull/1',
        reviews: [
          {
            author: { login: 'cubic-dev-ai' },
            state: 'COMMENTED',
            body: 'Please fix the hydration edge case.',
          },
        ],
      },
      null,
      'CHANGES_REQUESTED'
    );

    expect(summaries).toEqual([]);
  });

  it('includes changes-requested summaries in both modes', () => {
    const prDetails = {
      url: 'https://github.com/example/repo/pull/1',
      reviews: [
        {
          author: { login: 'reviewer' },
          state: 'CHANGES_REQUESTED',
          body: 'Please fix this.',
        },
      ],
    };

    expect(buildReviewSummariesForPrompt(prDetails, null, 'CHANGES_REQUESTED')).toHaveLength(1);
    expect(buildReviewSummariesForPrompt(prDetails, null, 'ALL_REVIEW_FEEDBACK')).toHaveLength(1);
  });
});

describe('computeLatestReviewActivityAtMs', () => {
  const prDetails = {
    reviews: [
      {
        submittedAt: '2026-01-02T00:00:00Z',
        author: { login: 'commenting-reviewer' },
        state: 'COMMENTED',
        body: 'Please address this feedback.',
      },
      {
        submittedAt: '2026-01-01T00:00:00Z',
        author: { login: 'changes-reviewer' },
        state: 'CHANGES_REQUESTED',
      },
    ],
    comments: [
      {
        updatedAt: '2026-01-04T00:00:00Z',
        author: { login: 'coverage-bot' },
      },
    ],
  };

  it('ignores ordinary PR comments and commented summaries in changes-requested mode', () => {
    expect(computeLatestReviewActivityAtMs(prDetails, [], null, 'CHANGES_REQUESTED')).toBe(
      Date.parse('2026-01-01T00:00:00Z')
    );
  });

  it('includes commented review submissions in all-feedback mode', () => {
    expect(computeLatestReviewActivityAtMs(prDetails, [], null, 'ALL_REVIEW_FEEDBACK')).toBe(
      Date.parse('2026-01-02T00:00:00Z')
    );
  });

  it('ignores empty commented review submissions in all-feedback mode', () => {
    expect(
      computeLatestReviewActivityAtMs(
        {
          ...prDetails,
          reviews: [
            {
              submittedAt: '2026-01-05T00:00:00Z',
              author: { login: 'empty-commenting-reviewer' },
              state: 'COMMENTED',
              body: '   ',
            },
            ...prDetails.reviews,
          ],
        },
        [],
        null,
        'ALL_REVIEW_FEEDBACK'
      )
    ).toBe(Date.parse('2026-01-02T00:00:00Z'));
  });

  it('ignores stale commented review activity after the same reviewer approves', () => {
    expect(
      computeLatestReviewActivityAtMs(
        {
          reviews: [
            {
              submittedAt: '2026-01-02T00:00:00Z',
              author: { login: 'reviewer-a' },
              state: 'COMMENTED',
              body: 'Please fix the first-round issue',
            },
            {
              submittedAt: '2026-01-03T00:00:00Z',
              author: { login: 'reviewer-a' },
              state: 'APPROVED',
              body: '',
            },
          ],
          comments: [],
        },
        [],
        null,
        'ALL_REVIEW_FEEDBACK'
      )
    ).toBeNull();
  });

  it('uses explicit chronological order when an approval timestamp is unparseable', () => {
    expect(
      computeLatestReviewActivityAtMs(
        {
          reviews: [
            {
              submittedAt: '2026-01-02T00:00:00Z',
              chronologicalOrder: 0,
              author: { login: 'reviewer-a' },
              state: 'COMMENTED',
              body: 'Please fix the first-round issue',
            },
            {
              submittedAt: 'not-a-timestamp',
              chronologicalOrder: 1,
              author: { login: 'reviewer-a' },
              state: 'APPROVED',
              body: '',
            },
          ],
          comments: [],
        },
        [],
        null,
        'ALL_REVIEW_FEEDBACK'
      )
    ).toBeNull();
  });

  it('uses submission time for activity when GitHub returns reviews out of order', () => {
    expect(
      computeLatestReviewActivityAtMs(
        {
          reviews: [
            {
              submittedAt: '2026-01-04T00:00:00Z',
              author: { login: 'reviewer-a' },
              state: 'COMMENTED',
              body: 'New feedback after approval',
            },
            {
              submittedAt: '2026-01-03T00:00:00Z',
              author: { login: 'reviewer-a' },
              state: 'APPROVED',
              body: '',
            },
            {
              submittedAt: '2026-01-02T00:00:00Z',
              author: { login: 'reviewer-a' },
              state: 'COMMENTED',
              body: 'Old feedback before approval',
            },
          ],
          comments: [],
        },
        [],
        null,
        'ALL_REVIEW_FEEDBACK'
      )
    ).toBe(Date.parse('2026-01-04T00:00:00Z'));
  });

  it('always includes inline review comment activity', () => {
    expect(
      computeLatestReviewActivityAtMs(
        prDetails,
        [
          {
            updatedAt: '2026-01-03T00:00:00Z',
            author: { login: 'inline-reviewer' },
          },
        ],
        null,
        'CHANGES_REQUESTED'
      )
    ).toBe(Date.parse('2026-01-03T00:00:00Z'));
  });
});

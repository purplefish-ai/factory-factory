import { describe, expect, it } from 'vitest';
import {
  buildReviewSummariesForPrompt,
  computeLatestReviewActivityAtMs,
} from './ratchet-pr-state.helpers';

const MARKER = '<!-- factory-factory:adversarial-review -->';

describe('adversarial-review marker recognition', () => {
  it('buildReviewSummariesForPrompt includes a marker-tagged commented review regardless of trigger mode', () => {
    const prDetails = {
      url: 'https://github.com/example/repo/pull/1',
      reviews: [
        {
          author: { login: 'factory-factory' },
          state: 'COMMENTED',
          body: `${MARKER}\nFound a bug.`,
        },
      ],
    };

    expect(buildReviewSummariesForPrompt(prDetails, null, 'CHANGES_REQUESTED')).toHaveLength(1);
    expect(buildReviewSummariesForPrompt(prDetails, null, 'ALL_REVIEW_FEEDBACK')).toHaveLength(1);
  });

  it('buildReviewSummariesForPrompt excludes an unmarked commented review under changes-requested mode', () => {
    const prDetails = {
      url: 'https://github.com/example/repo/pull/1',
      reviews: [
        {
          author: { login: 'human-reviewer' },
          state: 'COMMENTED',
          body: 'Looks fine to me.',
        },
      ],
    };

    expect(buildReviewSummariesForPrompt(prDetails, null, 'CHANGES_REQUESTED')).toHaveLength(0);
  });

  it('computeLatestReviewActivityAtMs includes a marker-tagged commented review even in changes-requested mode', () => {
    const timestamp = computeLatestReviewActivityAtMs(
      {
        reviews: [
          {
            submittedAt: '2026-01-05T00:00:00Z',
            author: { login: 'factory-factory' },
            state: 'COMMENTED',
            body: `${MARKER}\nFound a bug.`,
          },
        ],
        comments: [],
      },
      [],
      null,
      'CHANGES_REQUESTED'
    );

    expect(timestamp).toBe(Date.parse('2026-01-05T00:00:00Z'));
  });

  it('computeLatestReviewActivityAtMs ignores an unmarked commented review under changes-requested mode', () => {
    const timestamp = computeLatestReviewActivityAtMs(
      {
        reviews: [
          {
            submittedAt: '2026-01-05T00:00:00Z',
            author: { login: 'human-reviewer' },
            state: 'COMMENTED',
            body: 'Looks fine to me.',
          },
        ],
        comments: [],
      },
      [],
      null,
      'CHANGES_REQUESTED'
    );

    expect(timestamp).toBeNull();
  });
});

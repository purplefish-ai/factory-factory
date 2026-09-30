import { describe, expect, it } from 'vitest';
import { ADVERSARIAL_REVIEW_MARKER } from '@/shared/adversarial-review';
import {
  buildReviewSummariesForPrompt,
  computeLatestReviewActivityAtMs,
} from './ratchet-pr-state.helpers';

const APP_USERNAME = 'factory-factory';

describe('adversarial-review marker recognition', () => {
  it('buildReviewSummariesForPrompt includes a marker-tagged commented review from the app itself regardless of trigger mode', () => {
    const prDetails = {
      url: 'https://github.com/example/repo/pull/1',
      reviews: [
        {
          author: { login: APP_USERNAME },
          state: 'COMMENTED',
          body: `${ADVERSARIAL_REVIEW_MARKER}\nFound a bug.`,
        },
      ],
    };

    expect(
      buildReviewSummariesForPrompt(prDetails, APP_USERNAME, 'CHANGES_REQUESTED')
    ).toHaveLength(1);
    expect(
      buildReviewSummariesForPrompt(prDetails, APP_USERNAME, 'ALL_REVIEW_FEEDBACK')
    ).toHaveLength(1);
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

  it('buildReviewSummariesForPrompt excludes a marker copied into a review by someone other than the app', () => {
    const prDetails = {
      url: 'https://github.com/example/repo/pull/1',
      reviews: [
        {
          author: { login: 'not-the-app' },
          state: 'COMMENTED',
          body: `${ADVERSARIAL_REVIEW_MARKER}\nSpoofed review.`,
        },
      ],
    };

    expect(
      buildReviewSummariesForPrompt(prDetails, APP_USERNAME, 'CHANGES_REQUESTED')
    ).toHaveLength(0);
  });

  it('computeLatestReviewActivityAtMs includes a marker-tagged commented review from the app itself even in changes-requested mode', () => {
    const timestamp = computeLatestReviewActivityAtMs(
      {
        reviews: [
          {
            submittedAt: '2026-01-05T00:00:00Z',
            author: { login: APP_USERNAME },
            state: 'COMMENTED',
            body: `${ADVERSARIAL_REVIEW_MARKER}\nFound a bug.`,
          },
        ],
        comments: [],
      },
      [],
      APP_USERNAME,
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

  it('computeLatestReviewActivityAtMs ignores a marker copied into a review by someone other than the app', () => {
    const timestamp = computeLatestReviewActivityAtMs(
      {
        reviews: [
          {
            submittedAt: '2026-01-05T00:00:00Z',
            author: { login: 'not-the-app' },
            state: 'COMMENTED',
            body: `${ADVERSARIAL_REVIEW_MARKER}\nSpoofed review.`,
          },
        ],
        comments: [],
      },
      [],
      APP_USERNAME,
      'CHANGES_REQUESTED'
    );

    expect(timestamp).toBeNull();
  });
});

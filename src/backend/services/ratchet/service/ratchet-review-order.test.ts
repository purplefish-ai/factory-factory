import { describe, expect, it } from 'vitest';
import {
  buildReviewSummariesForPrompt,
  computeLatestReviewActivityAtMs,
} from './ratchet-pr-state.helpers';

const timestamp = '2026-01-01T00:00:00Z';
const approval = {
  author: { login: 'reviewer' },
  state: 'APPROVED',
  submittedAt: timestamp,
  chronologicalOrder: 1,
};

function feedback(state: string) {
  return {
    author: { login: 'reviewer' },
    state,
    body: 'Please fix this issue.',
    submittedAt: timestamp,
    chronologicalOrder: 0,
  };
}

type Review = Parameters<typeof computeLatestReviewActivityAtMs>[0]['reviews'][number] & {
  chronologicalOrder?: number;
};

function evaluate(reviews: Review[], mode: 'CHANGES_REQUESTED' | 'ALL_REVIEW_FEEDBACK') {
  const pr = { url: 'https://github.com/example/repo/pull/1', reviews, comments: [] };
  return {
    summaries: buildReviewSummariesForPrompt(pr, null, mode),
    activity: computeLatestReviewActivityAtMs(pr, [], null, mode),
  };
}

describe('review supersession ordering', () => {
  it.each([
    ['CHANGES_REQUESTED', 'CHANGES_REQUESTED'],
    ['COMMENTED', 'ALL_REVIEW_FEEDBACK'],
  ] as const)('drops same-second %s superseded by approval in %s mode', (state, mode) => {
    const stale = feedback(state);
    for (const reviews of [
      [stale, approval],
      [approval, stale],
    ]) {
      expect(evaluate(reviews, mode)).toEqual({ summaries: [], activity: null });
    }
  });

  it('retains feedback submitted after a same-second approval, regardless of input order', () => {
    const current = { ...feedback('CHANGES_REQUESTED'), chronologicalOrder: 2 };
    for (const reviews of [
      [current, approval],
      [approval, current],
    ]) {
      const result = evaluate(reviews, 'CHANGES_REQUESTED');
      expect(result.summaries.map((review) => review.body)).toEqual([current.body]);
      expect(result.activity).toBe(Date.parse(timestamp));
    }
  });

  it('never uses an unknown-author approval to supersede deleted-author feedback', () => {
    const unknownAuthor = { login: '(deleted reviewer)', isUnknown: true };
    const stale = { ...feedback('CHANGES_REQUESTED'), author: unknownAuthor };
    const unknownApproval = { ...approval, author: unknownAuthor };
    for (const reviews of [
      [stale, unknownApproval],
      [unknownApproval, stale],
    ]) {
      const result = evaluate(reviews, 'CHANGES_REQUESTED');
      expect(result.summaries.map((review) => review.body)).toEqual([stale.body]);
      expect(result.activity).toBe(Date.parse(timestamp));
    }
  });

  it('does not use another reviewer approval to supersede feedback', () => {
    const otherApproval = { ...approval, author: { login: 'other' } };
    const result = evaluate([feedback('CHANGES_REQUESTED'), otherApproval], 'CHANGES_REQUESTED');
    expect(result.summaries).toHaveLength(1);
    expect(result.activity).toBe(Date.parse(timestamp));
  });

  it('retains ambiguous same-second feedback when chronological metadata is absent', () => {
    const stale = { ...feedback('CHANGES_REQUESTED'), chronologicalOrder: undefined };
    const unknownApproval = { ...approval, chronologicalOrder: undefined };
    for (const reviews of [
      [stale, unknownApproval],
      [unknownApproval, stale],
    ]) {
      expect(evaluate(reviews, 'CHANGES_REQUESTED').summaries).toHaveLength(1);
    }
  });

  it('uses valid unequal submission times before chronological metadata', () => {
    const current = { ...feedback('CHANGES_REQUESTED'), submittedAt: '2026-01-02T00:00:00Z' };
    expect(evaluate([current, approval], 'CHANGES_REQUESTED').summaries).toHaveLength(1);
    const laterApproval = {
      ...approval,
      submittedAt: '2026-01-03T00:00:00Z',
      chronologicalOrder: 0,
    };
    expect(evaluate([laterApproval, current], 'CHANGES_REQUESTED')).toEqual({
      summaries: [],
      activity: null,
    });
  });

  it.each([null, 'not-a-timestamp'])(
    'uses chronological metadata when approval time is %s',
    (submittedAt) => {
      const stale = feedback('CHANGES_REQUESTED');
      const untimedApproval = { ...approval, submittedAt };
      for (const reviews of [
        [stale, untimedApproval],
        [untimedApproval, stale],
      ]) {
        expect(evaluate(reviews, 'CHANGES_REQUESTED')).toEqual({ summaries: [], activity: null });
      }
    }
  );
});

describe('untimed reviews', () => {
  it('uses explicit chronological order when stale feedback and approval timestamps are missing', () => {
    const summaries = buildReviewSummariesForPrompt(
      {
        url: 'https://github.com/example/repo/pull/1',
        reviews: [
          {
            chronologicalOrder: 0,
            author: { login: 'reviewer-a' },
            state: 'COMMENTED',
            body: 'Please fix the first-round issue',
          },
          {
            chronologicalOrder: 1,
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
});

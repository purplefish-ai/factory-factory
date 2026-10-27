import { describe, expect, it } from 'vitest';
import { prFailureSignature, reducePRObservation } from './pr-trigger-policy';
import type { PRObservation } from './schemas/pr-event.schema';

const target = { workspaceId: 'w', prId: 'p' };

import { redObservation } from './pr-monitoring.test-helpers';

function reduce(
  current: PRObservation,
  previous: PRObservation | null = null,
  extras: Partial<Parameters<typeof reducePRObservation>[0]> = {}
) {
  return reducePRObservation({
    target,
    previous,
    current,
    transitionSequence: 0,
    eventEpoch: 1,
    pendingEvents: [],
    deliveredEvents: [],
    ...extras,
  });
}
describe('PR event reduction', () => {
  it('does not reemit unchanged failures', () => {
    const first = reduce(redObservation);
    expect(first.events[0]?.kind).toBe('CI_FAILED');
    const reduction = reduce(
      { ...redObservation, observedAt: '2026-10-08T00:02:00.000Z' },
      redObservation,
      { pendingEvents: first.events.map((e, i) => ({ ...e, id: String(i) })) }
    );
    expect(reduction.events).toEqual([]);
  });
  it('distinguishes new heads and same-head reruns using actual metadata', () => {
    const key = reduce(redObservation).events[0]?.deduplicationKey;
    expect(
      reduce({ ...redObservation, headSha: 'new' }, redObservation).events[0]?.deduplicationKey
    ).not.toBe(key);
    expect(
      reduce(
        { ...redObservation, checks: [{ ...redObservation.checks[0]!, attempt: 2 }] },
        redObservation
      ).events[0]?.deduplicationKey
    ).not.toBe(key);
  });
  it('supersedes undelivered failures and emits recovery only after delivered failure', () => {
    const event = { ...reduce(redObservation).events[0]!, id: 'failed' };
    const success = {
      ...redObservation,
      ciStatus: 'SUCCESS' as const,
      checks: [{ ...redObservation.checks[0]!, conclusion: 'SUCCESS' }],
    };
    expect(reduce(success, redObservation, { pendingEvents: [event] })).toMatchObject({
      events: [],
      supersededEventIds: ['failed'],
    });
    expect(reduce(success, redObservation, { deliveredEvents: [event] }).events[0]?.kind).toBe(
      'CI_RECOVERED'
    );
    expect(
      reduce({ ...success, ciStatus: 'UNKNOWN' }, redObservation, { deliveredEvents: [event] })
        .events
    ).toEqual([]);
  });
  it('does not resolve omitted feedback from partial pagination', () => {
    const review = {
      identity: 'review1',
      contentHash: 'hash',
      author: 'reviewer',
      body: 'fix it',
      path: null,
      line: null,
      url: redObservation.url,
      activityAt: redObservation.observedAt,
    };
    const previous = {
      ...redObservation,
      ciStatus: 'SUCCESS' as const,
      actionableReviews: [review],
    };
    const event = {
      ...reduce(previous).events.find((e) => e.kind === 'REVIEW_FEEDBACK')!,
      id: 'review',
    };
    expect(
      reduce({ ...previous, actionableReviews: [], reviewsComplete: false }, previous, {
        pendingEvents: [event],
      }).supersededEventIds
    ).toEqual([]);
    expect(
      reduce({ ...previous, actionableReviews: [], reviewsComplete: true }, previous, {
        pendingEvents: [event],
      }).supersededEventIds
    ).toContain('review');
  });
  it('identifies repeated conflict and terminal transitions independently', () => {
    const conflict = { ...redObservation, hasMergeConflict: true };
    const first = reduce(conflict);
    const again = reduce(conflict, redObservation, {
      transitionSequence: first.nextTransitionSequence + 1,
    });
    expect(first.events.find((e) => e.kind === 'CONFLICT_DETECTED')?.deduplicationKey).not.toBe(
      again.events.find((e) => e.kind === 'CONFLICT_DETECTED')?.deduplicationKey
    );
    expect(
      reduce({ ...redObservation, prState: 'MERGED' }, redObservation).events.some(
        (e) => e.kind === 'PR_MERGED'
      )
    ).toBe(true);
  });
});

it('delivers a new failure after recovery even when provider metadata repeats', () => {
  const first = reduce(redObservation);
  const delivered = first.events.map((e, i) => ({ ...e, id: String(i) }));
  const green = { ...redObservation, ciStatus: 'SUCCESS' as const };
  const recovered = reduce(green, redObservation, {
    deliveredEvents: delivered,
    transitionSequence: first.nextTransitionSequence,
  });
  const again = reduce(redObservation, green, {
    deliveredEvents: delivered,
    transitionSequence: recovered.nextTransitionSequence,
  });
  expect(again.events.filter((e) => e.kind === 'CI_FAILED')).toHaveLength(1);
  expect(again.events[0]?.deduplicationKey).not.toBe(first.events[0]?.deduplicationKey);
});

it('emits feedback again when a resolved thread becomes actionable', () => {
  const review = {
    identity: 'thread',
    contentHash: 'hash',
    author: 'reviewer',
    body: 'fix it',
    path: null,
    line: null,
    url: redObservation.url,
    activityAt: redObservation.observedAt,
  };
  const observation = {
    ...redObservation,
    ciStatus: 'SUCCESS' as const,
    actionableReviews: [review],
  };
  const first = reduce(observation);
  const deliveredEvents = first.events.map((e) => ({ ...e, id: 'review' }));
  const resolved = { ...observation, actionableReviews: [] };
  const again = reduce(observation, resolved, {
    deliveredEvents,
    transitionSequence: first.nextTransitionSequence,
  });
  expect(again.events.filter((e) => e.kind === 'REVIEW_FEEDBACK')).toHaveLength(1);
});
it('seeds current failures once per monitoring epoch and distinguishes sibling PRs', () => {
  const first = reduce(redObservation).events[0]!;
  expect(
    reduce(redObservation, null, { eventEpoch: 2, deliveredEvents: [{ ...first, id: 'old' }] })
      .events
  ).toHaveLength(1);
  expect(
    reduce(redObservation, null, { target: { ...target, prId: 'sibling' } }).events[0]
      ?.deduplicationKey
  ).not.toBe(first.deduplicationKey);
});
it('reports a delivered CI failure recovering through pending exactly once', () => {
  const failed = { ...reduce(redObservation).events[0]!, id: 'delivered-failure' };
  const pending = { ...redObservation, ciStatus: 'PENDING' as const };
  const success = { ...redObservation, ciStatus: 'SUCCESS' as const };
  const recovered = reduce(success, pending, { deliveredEvents: [failed] });
  expect(recovered.events.map((e) => e.kind)).toEqual(['CI_RECOVERED']);
  const recovery = { ...recovered.events[0]!, id: 'recovered' };
  expect(
    reduce(success, success, { deliveredEvents: [failed], pendingEvents: [recovery] }).events
  ).toEqual([]);
  expect(reduce(success, success, { deliveredEvents: [failed, recovery] }).events).toEqual([]);
  expect(
    reduce({ ...success, headSha: 'new-head' }, pending, { deliveredEvents: [failed] }).events
  ).toEqual([]);
});

it('reports conflict clearance after a frozen in-flight detection', () => {
  const conflict = { ...redObservation, hasMergeConflict: true };
  const detected = {
    ...reduce(conflict).events.find((e) => e.kind === 'CONFLICT_DETECTED')!,
    id: 'frozen',
  };
  expect(
    reduce(redObservation, conflict, { inFlightEvents: [detected] }).events.map((e) => e.kind)
  ).toContain('CONFLICT_CLEARED');
  expect(
    reduce(redObservation, conflict, { pendingEvents: [detected] }).events.map((e) => e.kind)
  ).not.toContain('CONFLICT_CLEARED');
});

it('supersedes explicitly resolved review feedback despite incomplete pagination', () => {
  const review = {
    identity: 'comment:123',
    contentHash: 'hash',
    author: 'reviewer',
    body: 'fix',
    path: null,
    line: null,
    url: redObservation.url,
    activityAt: redObservation.observedAt,
  };
  const previous = { ...redObservation, actionableReviews: [review] };
  const event = {
    ...reduce(previous).events.find((e) => e.kind === 'REVIEW_FEEDBACK')!,
    id: 'resolved',
  };
  expect(
    reduce(
      {
        ...previous,
        actionableReviews: [],
        reviewsComplete: false,
        resolvedReviewIds: ['comment:123'],
      },
      previous,
      { pendingEvents: [event] }
    ).supersededEventIds
  ).toContain('resolved');
});

it('keeps failure signatures stable across ordering and distinguishes changed same-head failures', () => {
  expect(prFailureSignature(redObservation)).toBe(
    '[["run-1",1,"test","CI","https://github.com/org/repo/actions/runs/1",null,null,"FAILURE"]]'
  );
  const changed = {
    ...redObservation,
    checks: [{ ...redObservation.checks[0]!, completedAt: '2026-10-08T00:01:00.000Z' }],
  };
  expect(reduce(changed, redObservation).events.map((e) => e.kind)).toEqual(['CI_FAILED']);
  const checks = [redObservation.checks[0]!, { ...redObservation.checks[0]!, identity: 'run-2' }];
  expect(prFailureSignature({ ...redObservation, checks })).toBe(
    prFailureSignature({ ...redObservation, checks: checks.toReversed() })
  );
});

it.each(['PENDING', 'UNKNOWN'] as const)(
  'does not supersede a failure or recover for %s CI',
  (ciStatus) => {
    const failure = { ...reduce(redObservation).events[0]!, id: 'failed' };
    expect(
      reduce({ ...redObservation, ciStatus }, redObservation, { pendingEvents: [failure] })
    ).toMatchObject({
      events: [],
      supersededEventIds: [],
      nextTransitionSequence: 0,
    });
    expect(
      reduce({ ...redObservation, ciStatus }, redObservation, { deliveredEvents: [failure] }).events
    ).toEqual([]);
  }
);

it('recovers against the latest delivered failure even when ledger reads are unordered', () => {
  const first = {
    ...reduce(redObservation).events[0]!,
    id: 'first',
    deduplicationKey: 'first-key',
  };
  const latest = {
    ...first,
    id: 'latest',
    deduplicationKey: 'latest-key',
    payload: {
      ...first.payload,
      observation: { ...redObservation, observedAt: '2026-10-08T00:02:00.000Z' },
    },
  };
  expect(
    reduce({ ...redObservation, ciStatus: 'SUCCESS' }, redObservation, {
      deliveredEvents: [latest, first],
    }).events
  ).toMatchObject([
    { kind: 'CI_RECOVERED', deduplicationKey: 'p:epoch:1:CI_RECOVERED:head-1:latest-key' },
  ]);
});

it('supersedes obsolete unfrozen facts while retaining frozen in-flight facts', () => {
  const failure = { ...reduce(redObservation).events[0]!, id: 'unfrozen' };
  const frozen = { ...failure, id: 'frozen' };
  const result = reduce({ ...redObservation, headSha: 'new-head' }, redObservation, {
    pendingEvents: [failure],
    inFlightEvents: [frozen],
  });
  expect(result.supersededEventIds).toEqual(['unfrozen']);
  expect(result.events.map((e) => e.kind)).toEqual(['CI_FAILED']);
  expect(reduce(redObservation, null, { inFlightEvents: [frozen] }).events).toEqual([]);
});

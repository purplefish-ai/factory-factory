import { describe, expect, it } from 'vitest';
import { deriveCiStatusFromCheckRollup } from './core';
import {
  isSettledPRFailure,
  PR_FAILURE_MAX_WAIT_MS,
  prFailureSignature,
  reducePRObservation,
} from './pr-trigger-policy';
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
    const base = reduce(redObservation);
    const newHead = reduce({ ...redObservation, headSha: 'new' }, redObservation);
    const rerun = reduce(
      { ...redObservation, checks: [{ ...redObservation.checks[0]!, attempt: 2 }] },
      redObservation
    );
    for (const result of [base, newHead, rerun]) {
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({ kind: 'CI_FAILED' });
    }
    const key = base.events[0]!.deduplicationKey;
    expect(newHead.events[0]!.deduplicationKey).not.toBe(key);
    expect(rerun.events[0]!.deduplicationKey).not.toBe(key);
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
    { kind: 'CI_RECOVERED', deduplicationKey: 'p:epoch:1:CI_RECOVERED:head-1:latest-key:1' },
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

describe('review feedback across pushes', () => {
  const review = {
    identity: 'comment:42',
    contentHash: 'hash',
    author: 'reviewer',
    body: 'Rename this helper',
    path: 'src/a.ts',
    line: 3,
    url: `${redObservation.url}#discussion_r42`,
    activityAt: redObservation.observedAt,
  };
  const green = { ...redObservation, ciStatus: 'SUCCESS' as const, actionableReviews: [review] };
  const pushed = { ...green, headSha: 'head-2', observedAt: '2026-10-08T00:05:00.000Z' };

  it('does not redeliver already delivered feedback after the agent pushes a new head', () => {
    // The agent receives the unresolved thread, pushes a fix, and the reviewer
    // has not resolved the thread yet. The push alone is not new feedback.
    const first = reduce(green);
    const delivered = first.events.map((e) => ({ ...e, id: 'delivered-review' }));
    expect(delivered.map((e) => e.kind)).toEqual(['REVIEW_FEEDBACK']);
    const afterPush = reduce(pushed, green, {
      deliveredEvents: delivered,
      transitionSequence: first.nextTransitionSequence,
    });
    expect(afterPush.events.filter((e) => e.kind === 'REVIEW_FEEDBACK')).toEqual([]);
  });

  it('keeps feedback frozen in flight across a push until its receipt is proven', () => {
    const first = reduce(green);
    const frozen = first.events.map((e) => ({ ...e, id: 'frozen-review' }));
    const afterPush = reduce(pushed, green, {
      inFlightEvents: frozen,
      transitionSequence: first.nextTransitionSequence,
    });
    const reemitted = afterPush.events.map((e) => ({ ...e, id: 'reemitted-review' }));
    expect(reemitted.map((e) => e.kind)).toEqual(['REVIEW_FEEDBACK']);
    // Receipt recovery may cancel the frozen claim and requeue its stale-head
    // payload as a fresh row; that row is superseded, so the re-emission must
    // survive or the feedback never reaches the agent.
    const requeued = frozen.map((e) => ({ ...e, id: 'requeued-review' }));
    const afterCancel = reduce(pushed, pushed, {
      pendingEvents: [...requeued, ...reemitted],
      transitionSequence: afterPush.nextTransitionSequence,
    });
    expect(afterCancel.supersededEventIds).toEqual(['requeued-review']);
    expect(afterCancel.events).toEqual([]);
  });

  it('drops the in-flight re-emission once the frozen delivery is received', () => {
    const first = reduce(green);
    const frozen = first.events.map((e) => ({ ...e, id: 'frozen-review' }));
    const afterPush = reduce(pushed, green, {
      inFlightEvents: frozen,
      transitionSequence: first.nextTransitionSequence,
    });
    const reemitted = afterPush.events.map((e) => ({
      ...e,
      id: 'reemitted-review',
      createdAt: new Date('2026-10-08T00:05:00.000Z'),
    }));
    const received = frozen.map((e) => ({
      ...e,
      deliveredAt: new Date('2026-10-08T00:06:00.000Z'),
    }));
    const afterReceipt = reduce(pushed, pushed, {
      deliveredEvents: received,
      pendingEvents: reemitted,
      transitionSequence: afterPush.nextTransitionSequence,
    });
    expect(afterReceipt.supersededEventIds).toEqual(['reemitted-review']);
    expect(afterReceipt.events).toEqual([]);
  });

  it('keeps a re-opened thread queued after its earlier delivery', () => {
    const first = reduce(green);
    const delivered = first.events.map((e) => ({
      ...e,
      id: 'delivered-review',
      deliveredAt: new Date('2026-10-08T00:01:00.000Z'),
    }));
    const resolved = { ...green, actionableReviews: [], resolvedReviewIds: [review.identity] };
    const reopened = reduce(green, resolved, {
      deliveredEvents: delivered,
      transitionSequence: first.nextTransitionSequence,
    });
    const queued = reopened.events.map((e) => ({
      ...e,
      id: 'reopened-review',
      createdAt: new Date('2026-10-08T00:03:00.000Z'),
    }));
    expect(queued.map((e) => e.kind)).toEqual(['REVIEW_FEEDBACK']);
    const refreshed = reduce(green, green, {
      deliveredEvents: delivered,
      pendingEvents: queued,
      transitionSequence: reopened.nextTransitionSequence,
    });
    expect(refreshed.supersededEventIds).toEqual([]);
  });

  it('re-emits undelivered feedback that a new head supersedes', () => {
    const first = reduce(green);
    const pending = first.events.map((e) => ({ ...e, id: 'pending-review' }));
    const afterPush = reduce(pushed, green, {
      pendingEvents: pending,
      transitionSequence: first.nextTransitionSequence,
    });
    expect(afterPush.supersededEventIds).toEqual(['pending-review']);
    expect(afterPush.events.map((e) => e.kind)).toEqual(['REVIEW_FEEDBACK']);
  });

  it('delivers edited feedback after a push', () => {
    const first = reduce(green);
    const delivered = first.events.map((e) => ({ ...e, id: 'delivered-review' }));
    const edited = { ...pushed, actionableReviews: [{ ...review, contentHash: 'edited' }] };
    const afterEdit = reduce(edited, green, {
      deliveredEvents: delivered,
      transitionSequence: first.nextTransitionSequence,
    });
    expect(afterEdit.events.map((e) => e.kind)).toEqual(['REVIEW_FEEDBACK']);
  });
});

const at = (minute: number) => `2026-10-08T00:${String(minute).padStart(2, '0')}:00.000Z`;
const kindsOf = (reduction: ReturnType<typeof reduce>) => reduction.events.map((e) => e.kind);

describe('conflict facts', () => {
  const clean = { ...redObservation, ciStatus: 'SUCCESS' as const, checks: [] };
  const conflicted = { ...clean, hasMergeConflict: true, observedAt: at(1) };
  const detection = reduce(conflicted, clean);
  const detected = { ...detection.events[0]!, id: 'detected' };

  it('re-emits an undelivered conflict that a new head supersedes', () => {
    // The agent was busy when the conflict appeared and pushed without resolving it.
    const pushed = { ...conflicted, headSha: 'head-2', observedAt: at(2) };
    const afterPush = reduce(pushed, conflicted, {
      pendingEvents: [detected],
      transitionSequence: detection.nextTransitionSequence,
    });
    expect(afterPush.supersededEventIds).toEqual(['detected']);
    expect(kindsOf(afterPush)).toEqual(['CONFLICT_DETECTED']);
    expect(afterPush.events[0]?.payload.observation.headSha).toBe('head-2');
    for (const told of ['deliveredEvents', 'inFlightEvents'] as const) {
      expect(reduce(pushed, conflicted, { [told]: [detected] }).events).toEqual([]);
    }
  });

  it('reports a clearance only for the conflict the recipient last heard about', () => {
    const cleared = {
      ...reduce({ ...clean, observedAt: at(2) }, conflicted, { deliveredEvents: [detected] })
        .events[0]!,
      id: 'cleared',
    };
    expect(cleared.kind).toBe('CONFLICT_CLEARED');
    // A second conflict that clears before it is delivered was never announced.
    const second = { ...conflicted, observedAt: at(3) };
    const secondDetected = {
      ...reduce(second, clean, { deliveredEvents: [detected, cleared], transitionSequence: 2 })
        .events[0]!,
      id: 'second',
    };
    const afterSecond = reduce({ ...clean, observedAt: at(4) }, second, {
      deliveredEvents: [detected, cleared],
      pendingEvents: [secondDetected],
      transitionSequence: 3,
    });
    expect(afterSecond.supersededEventIds).toEqual(['second']);
    expect(afterSecond.events).toEqual([]);
  });

  it('drops a queued clearance when the conflict returns', () => {
    const cleared = {
      ...reduce({ ...clean, observedAt: at(2) }, conflicted, { deliveredEvents: [detected] })
        .events[0]!,
      id: 'cleared',
    };
    const returned = reduce({ ...conflicted, observedAt: at(3) }, clean, {
      deliveredEvents: [detected],
      pendingEvents: [cleared],
      transitionSequence: 2,
    });
    expect(returned.supersededEventIds).toEqual(['cleared']);
    expect(kindsOf(returned)).toEqual(['CONFLICT_DETECTED']);
  });

  it('re-emits an undelivered clearance that a new head supersedes', () => {
    const resolved = { ...clean, headSha: 'head-2', observedAt: at(2) };
    const cleared = {
      ...reduce(resolved, conflicted, { deliveredEvents: [detected] }).events[0]!,
      id: 'cleared',
    };
    const pushed = { ...resolved, headSha: 'head-3', observedAt: at(3) };
    const afterPush = reduce(pushed, resolved, {
      deliveredEvents: [detected],
      pendingEvents: [cleared],
      transitionSequence: 2,
    });
    expect(afterPush.supersededEventIds).toEqual(['cleared']);
    expect(kindsOf(afterPush)).toEqual(['CONFLICT_CLEARED']);
    expect(reduce(pushed, resolved, { deliveredEvents: [detected, cleared] }).events).toEqual([]);
  });
});

describe('CI failures while checks are still running', () => {
  const failed = redObservation.checks[0]!;
  const running = {
    ...failed,
    identity: 'run-2',
    name: 'lint',
    status: 'IN_PROGRESS',
    conclusion: null,
  };
  const passed = { ...running, status: 'COMPLETED', conclusion: 'SUCCESS' };
  const unsettled = { ...redObservation, checks: [failed, running] };
  const settled = { ...redObservation, checks: [failed, passed] };

  it('waits for the run to finish before announcing a failure', () => {
    const first = reduce(unsettled);
    expect(first).toMatchObject({ events: [], nextTransitionSequence: 0 });
    expect(first.storedObservation.ciFailure?.announced).toBe(false);
    const finished = reduce(settled, first.storedObservation);
    expect(kindsOf(finished)).toEqual(['CI_FAILED']);
    expect(finished.storedObservation.ciFailure?.announced).toBe(true);
    expect(reduce(settled, finished.storedObservation).events).toEqual([]);
  });

  it('announces one failure for a run in which a second check fails later', () => {
    const first = reduce(unsettled);
    const both = {
      ...redObservation,
      checks: [failed, { ...passed, conclusion: 'FAILURE' }],
    };
    const finished = reduce(both, first.storedObservation);
    expect(kindsOf(finished)).toEqual(['CI_FAILED']);
    expect(finished.events[0]?.payload.observation.checks).toHaveLength(2);
  });

  it.each(['pendingEvents', 'deliveredEvents'] as const)(
    'does not repeat an announced failure (%s) while another check is re-run',
    (state) => {
      const announced = reduce(settled);
      const ledger = { [state]: [{ ...announced.events[0]!, id: 'announced' }] };
      const rerun = reduce(unsettled, announced.storedObservation, ledger);
      expect(rerun).toMatchObject({ events: [], supersededEventIds: [] });
      expect(rerun.storedObservation.ciFailure?.announced).toBe(true);
      expect(reduce(settled, rerun.storedObservation, ledger).events).toEqual([]);
    }
  );

  it('announces a failure that recurs with identical metadata after CI passed', () => {
    // Commit statuses carry no timestamps, so a repeated failure has the same signature.
    const announced = reduce(settled);
    const delivered = [{ ...announced.events[0]!, id: 'announced' }];
    const green = { ...redObservation, ciStatus: 'SUCCESS' as const, checks: [passed] };
    const recovered = reduce(green, announced.storedObservation, { deliveredEvents: delivered });
    expect(kindsOf(recovered)).toEqual(['CI_RECOVERED']);
    const failing = reduce(unsettled, recovered.storedObservation, { deliveredEvents: delivered });
    expect(failing.events).toEqual([]);
    const finished = reduce(settled, failing.storedObservation, {
      deliveredEvents: delivered,
      transitionSequence: recovered.nextTransitionSequence,
    });
    expect(kindsOf(finished)).toEqual(['CI_FAILED']);
    expect(finished.events[0]?.deduplicationKey).not.toBe(announced.events[0]?.deduplicationKey);
  });

  it.each([
    'PENDING',
    'EXPECTED',
    'QUEUED',
    'IN_PROGRESS',
    'WAITING',
    'REQUESTED',
    'COMPLETED',
    'UNKNOWN',
  ])('agrees with the CI status derivation on whether a %s check is running', (status) => {
    // The policy takes no runtime import, so it restates which statuses are not terminal.
    const check = { ...running, status, conclusion: status === 'COMPLETED' ? 'SUCCESS' : null };
    expect(isSettledPRFailure({ ...redObservation, checks: [failed, check] })).toBe(
      deriveCiStatusFromCheckRollup([check]) !== 'PENDING'
    );
  });

  it('announces a failure once when its run never finishes', () => {
    // For example a job awaiting approval, or a required status nobody reports.
    const first = reduce(unsettled);
    const later = (ms: number) => ({
      ...unsettled,
      observedAt: new Date(Date.parse(unsettled.observedAt) + ms).toISOString(),
    });
    const waiting = reduce(later(PR_FAILURE_MAX_WAIT_MS - 1), first.storedObservation);
    expect(waiting.events).toEqual([]);
    const overdue = reduce(later(PR_FAILURE_MAX_WAIT_MS), waiting.storedObservation);
    expect(kindsOf(overdue)).toEqual(['CI_FAILED']);
    const pending = { pendingEvents: [{ ...overdue.events[0]!, id: 'overdue' }] };
    expect(
      reduce(later(2 * PR_FAILURE_MAX_WAIT_MS), overdue.storedObservation, pending).events
    ).toEqual([]);
    expect(reduce(settled, overdue.storedObservation, pending).events).toEqual([]);
  });

  it('treats a failure stored before the field existed as announced', () => {
    expect(reduce(settled, unsettled).events).toEqual([]);
  });
});

it('drops a queued recovery when CI fails again and reports the next recovery separately', () => {
  const failure = { ...reduce(redObservation).events[0]!, id: 'failure' };
  const green = { ...redObservation, ciStatus: 'SUCCESS' as const, checks: [], observedAt: at(1) };
  const first = reduce(green, redObservation, { deliveredEvents: [failure] });
  const recovery = { ...first.events[0]!, id: 'recovery' };
  expect(recovery.kind).toBe('CI_RECOVERED');
  const redAgain = {
    ...redObservation,
    checks: [{ ...redObservation.checks[0]!, completedAt: at(2) }],
    observedAt: at(2),
  };
  const failedAgain = reduce(redAgain, green, {
    deliveredEvents: [failure],
    pendingEvents: [recovery],
    transitionSequence: first.nextTransitionSequence,
  });
  expect(failedAgain.supersededEventIds).toEqual(['recovery']);
  expect(kindsOf(failedAgain)).toEqual(['CI_FAILED']);
  // The second failure is superseded undelivered, so the same delivered failure recovers again.
  const second = reduce({ ...green, observedAt: at(3) }, failedAgain.storedObservation, {
    deliveredEvents: [failure],
    pendingEvents: [{ ...failedAgain.events[0]!, id: 'second-failure' }],
    transitionSequence: failedAgain.nextTransitionSequence,
  });
  expect(second.supersededEventIds).toEqual(['second-failure']);
  expect(kindsOf(second)).toEqual(['CI_RECOVERED']);
  expect(second.events[0]?.deduplicationKey).not.toBe(recovery.deduplicationKey);
});

it('drops a queued closure when the PR is reopened', () => {
  const closed = { ...redObservation, prState: 'CLOSED' as const };
  const closure = { ...reduce(closed, redObservation).events[0]!, id: 'closure' };
  expect(closure.kind).toBe('PR_CLOSED');
  expect(reduce(closed, closed, { pendingEvents: [closure] }).supersededEventIds).toEqual([]);
  expect(reduce(redObservation, closed, { pendingEvents: [closure] }).supersededEventIds).toEqual([
    'closure',
  ]);
});

describe('the stored observation', () => {
  const review = {
    identity: 'comment:9',
    contentHash: 'hash',
    author: 'reviewer',
    body: 'Handle the empty case',
    path: 'src/a.ts',
    line: 1,
    url: `${redObservation.url}#discussion_r9`,
    activityAt: redObservation.observedAt,
  };
  const withReview = { ...redObservation, actionableReviews: [review] };
  const unread = { ...redObservation, actionableReviews: [], reviewsComplete: false };

  it('keeps feedback this epoch observed when a review read is incomplete', () => {
    expect(reduce(unread, withReview).storedObservation.actionableReviews).toEqual([review]);
    expect(
      reduce({ ...unread, resolvedReviewIds: [review.identity] }, withReview).storedObservation
        .actionableReviews
    ).toEqual([]);
  });

  it('carries nothing into a new epoch, so its first complete read states the feedback', () => {
    // `previous` is null when the stored observation belongs to an earlier epoch.
    const first = reduce(unread, null);
    expect(first.storedObservation.actionableReviews).toEqual([]);
    expect(kindsOf(reduce(withReview, first.storedObservation))).toContain('REVIEW_FEEDBACK');
  });

  it('is not copied into facts with its review list', () => {
    const other = { ...review, identity: 'comment:10' };
    const reduction = reduce({
      ...withReview,
      actionableReviews: [review, other],
      resolvedReviewIds: ['comment:1'],
    });
    for (const event of reduction.events) {
      expect(event.payload.observation).toMatchObject({ actionableReviews: [] });
      expect(event.payload.observation).not.toHaveProperty('resolvedReviewIds');
      expect(event.payload.observation).not.toHaveProperty('ciFailure');
    }
    expect(
      reduction.events.flatMap((e) =>
        e.payload.kind === 'REVIEW_FEEDBACK' ? e.payload.reviews : []
      )
    ).toEqual([review, other]);
  });
});

it('re-emits undelivered feedback on a new head whose review read is incomplete', () => {
  const review = {
    identity: 'comment:11',
    contentHash: 'hash',
    author: 'reviewer',
    body: 'Guard the null case',
    path: 'src/a.ts',
    line: 4,
    url: `${redObservation.url}#discussion_r11`,
    activityAt: redObservation.observedAt,
  };
  const green = { ...redObservation, ciStatus: 'SUCCESS' as const, checks: [] };
  const observed = reduce({ ...green, actionableReviews: [review] });
  const queued = { ...observed.events[0]!, id: 'queued' };
  // The push supersedes the queued fact, and the read that sees the push returns no reviews.
  const unread = { ...green, headSha: 'head-2', observedAt: at(5), reviewsComplete: false };
  const afterPush = reduce(unread, observed.storedObservation, {
    pendingEvents: [queued],
    transitionSequence: observed.nextTransitionSequence,
  });
  expect(afterPush.supersededEventIds).toEqual(['queued']);
  expect(afterPush.events).toMatchObject([
    { kind: 'REVIEW_FEEDBACK', payload: { reviews: [review], observation: { headSha: 'head-2' } } },
  ]);
  // The complete read that follows finds it queued and neither drops nor repeats it.
  const requeued = { ...afterPush.events[0]!, id: 'requeued' };
  expect(
    reduce(
      { ...unread, actionableReviews: [review], reviewsComplete: true },
      afterPush.storedObservation,
      {
        pendingEvents: [requeued],
        transitionSequence: afterPush.nextTransitionSequence,
      }
    )
  ).toMatchObject({ events: [], supersededEventIds: [] });
  // Feedback the recipient already has is not repeated by the push.
  expect(reduce(unread, observed.storedObservation, { deliveredEvents: [queued] }).events).toEqual(
    []
  );
});

describe('without a usable baseline, the ledger decides what is restated', () => {
  const review = {
    identity: 'comment:7',
    contentHash: 'hash',
    author: 'reviewer',
    body: 'Split this function',
    path: 'src/a.ts',
    line: 2,
    url: `${redObservation.url}#discussion_r7`,
    activityAt: redObservation.observedAt,
  };
  const open = { ...redObservation, hasMergeConflict: true, actionableReviews: [review] };
  const everything = ['CI_FAILED', 'CONFLICT_DETECTED', 'REVIEW_FEEDBACK'];
  const first = reduce(open);
  const facts = (id: string) => first.events.map((e) => ({ ...e, id: `${id}-${e.kind}` }));
  const after = { transitionSequence: first.nextTransitionSequence };
  const failed = redObservation.checks[0]!;
  const running = { ...failed, identity: 'run-2', status: 'IN_PROGRESS', conclusion: null };

  function closeAndReopen(ledger: 'pendingEvents' | 'deliveredEvents') {
    const closing = reduce(
      { ...open, prState: 'CLOSED', observedAt: at(1) },
      first.storedObservation,
      {
        ...after,
        [ledger]: facts('fact'),
      }
    );
    const closure = { ...closing.events[0]!, id: 'closure' };
    expect(closure.kind).toBe('PR_CLOSED');
    return reduce({ ...open, observedAt: at(2) }, closing.storedObservation, {
      transitionSequence: closing.nextTransitionSequence,
      pendingEvents: [closure],
      deliveredEvents: ledger === 'deliveredEvents' ? facts('fact') : [],
    });
  }

  it('restates on reopening the facts a closure superseded before they were delivered', () => {
    expect(kindsOf(first)).toEqual(everything);
    const reopened = closeAndReopen('pendingEvents');
    expect(reopened.supersededEventIds).toEqual(['closure']);
    expect(kindsOf(reopened)).toEqual(everything);
    expect(reopened.storedObservation.ciFailure?.announced).toBe(true);
    const pendingEvents = reopened.events.map((e) => ({ ...e, id: e.deduplicationKey }));
    expect(
      reduce({ ...open, observedAt: at(3) }, reopened.storedObservation, { pendingEvents }).events
    ).toEqual([]);
  });

  it('does not restate on reopening what the recipient received before the close', () => {
    const reopened = closeAndReopen('deliveredEvents');
    expect(reopened.events).toEqual([]);
    expect(reopened.storedObservation.ciFailure?.announced).toBe(true);
  });

  it('announces once on reopening a failure whose run was still running at the close', () => {
    const unsettled = { ...redObservation, checks: [failed, running] };
    const opened = reduce(unsettled);
    expect(opened.events).toEqual([]);
    const closing = reduce(
      { ...unsettled, prState: 'CLOSED', observedAt: at(1) },
      opened.storedObservation
    );
    const settled = { ...unsettled, checks: [failed], observedAt: at(2) };
    const reopened = reduce(settled, closing.storedObservation, {
      transitionSequence: closing.nextTransitionSequence,
    });
    expect(kindsOf(reopened)).toEqual(['CI_FAILED']);
    const deliveredEvents = [{ ...reopened.events[0]!, id: 'announced' }];
    expect(
      reduce({ ...settled, observedAt: at(3) }, reopened.storedObservation, { deliveredEvents })
        .events
    ).toEqual([]);
  });

  it.each(['deliveredEvents', 'inFlightEvents', 'pendingEvents'] as const)(
    'does not repeat facts that are in %s when the stored observation is unreadable',
    (ledger) => {
      const lost = reduce({ ...open, observedAt: at(1) }, null, { ...after, [ledger]: facts('x') });
      expect(lost).toMatchObject({ events: [], supersededEventIds: [] });
      expect(lost.storedObservation.ciFailure?.announced).toBe(true);
    }
  );

  it('restates a failure without a baseline once a recovery answered its announcement', () => {
    const announced = { ...first.events[0]!, id: 'failed' };
    const green = {
      ...redObservation,
      ciStatus: 'SUCCESS' as const,
      checks: [],
      observedAt: at(1),
    };
    const recovery = {
      ...reduce(green, redObservation, { deliveredEvents: [announced] }).events[0]!,
      id: 'recovered',
    };
    expect(recovery.kind).toBe('CI_RECOVERED');
    const again = { ...redObservation, observedAt: at(2) };
    const deliveredEvents = [announced, recovery];
    expect(kindsOf(reduce(again, null, { deliveredEvents, transitionSequence: 2 }))).toEqual([
      'CI_FAILED',
    ]);
    // A failure of other checks on the same head is a new announcement too.
    const changed = { ...again, checks: [{ ...failed, completedAt: at(2) }] };
    expect(kindsOf(reduce(changed, null, { deliveredEvents: [announced] }))).toEqual(['CI_FAILED']);
  });

  it('keeps a failure announced when the baseline is lost before its run finishes', () => {
    // The failure was announced at the 30-minute limit while a check kept running.
    const unsettled = { ...redObservation, checks: [failed, running], observedAt: at(40) };
    const delivered = { deliveredEvents: [{ ...first.events[0]!, id: 'overdue' }] };
    const lost = reduce(unsettled, null, delivered);
    expect(lost.events).toEqual([]);
    expect(lost.storedObservation.ciFailure?.announced).toBe(true);
    const settled = { ...unsettled, checks: [failed], observedAt: at(41) };
    expect(reduce(settled, lost.storedObservation, delivered).events).toEqual([]);
  });

  it('clears without a baseline a conflict the recipient was told about, once', () => {
    const clean = { ...open, hasMergeConflict: false, observedAt: at(1) };
    const told = facts('told');
    const cleared = reduce(clean, null, { ...after, deliveredEvents: told });
    expect(kindsOf(cleared)).toEqual(['CONFLICT_CLEARED']);
    const clearance = { ...cleared.events[0]!, id: 'clearance' };
    expect(
      reduce(clean, null, { deliveredEvents: told, pendingEvents: [clearance] }).events
    ).toEqual([]);
    expect(reduce(clean, null, { deliveredEvents: [...told, clearance] }).events).toEqual([]);
    // The conflict returns: the recipient last heard it cleared, so it is detected again.
    const returned = reduce({ ...open, observedAt: at(2) }, null, {
      deliveredEvents: [...told, clearance],
      transitionSequence: 4,
    });
    expect(kindsOf(returned)).toEqual(['CONFLICT_DETECTED']);
  });

  it('restates without a baseline feedback in flight for an earlier head, not delivered feedback', () => {
    const pushed = { ...open, headSha: 'head-2', observedAt: at(1) };
    const feedback = facts('review').filter((e) => e.kind === 'REVIEW_FEEDBACK');
    expect(kindsOf(reduce(pushed, null, { ...after, inFlightEvents: feedback }))).toContain(
      'REVIEW_FEEDBACK'
    );
    expect(kindsOf(reduce(pushed, null, { ...after, deliveredEvents: feedback }))).not.toContain(
      'REVIEW_FEEDBACK'
    );
  });

  it('keeps stated feedback as the baseline when the baseline is lost on an incomplete read', () => {
    const delivered = { ...after, deliveredEvents: facts('told') };
    const unread = { ...open, actionableReviews: [], reviewsComplete: false, observedAt: at(1) };
    const lost = reduce(unread, null, delivered);
    expect(lost.events).toEqual([]);
    expect(lost.storedObservation.actionableReviews).toEqual([review]);
    expect(
      reduce({ ...open, observedAt: at(2) }, lost.storedObservation, delivered).events
    ).toEqual([]);
  });

  it('ignores ledger rows of another epoch, whose destination was another one', () => {
    expect(kindsOf(reduce(open, null, { eventEpoch: 2, deliveredEvents: facts('old') }))).toEqual(
      everything
    );
  });

  it('reports a merge or closure without a baseline once per transition', () => {
    const hashIdentity = (identity: string) => `#${identity}`;
    const green = { ...redObservation, ciStatus: 'SUCCESS' as const, checks: [] };
    for (const prState of ['CLOSED', 'MERGED'] as const) {
      const ended = { ...green, prState, observedAt: at(1) };
      const ending = reduce(ended, green, { hashIdentity });
      const fact = { ...ending.events[0]!, id: 'ended' };
      expect(fact.kind).toBe(prState === 'MERGED' ? 'PR_MERGED' : 'PR_CLOSED');
      for (const ledger of ['deliveredEvents', 'inFlightEvents', 'pendingEvents'] as const) {
        const sequence = { transitionSequence: ending.nextTransitionSequence };
        expect(reduce(ended, null, { hashIdentity, ...sequence, [ledger]: [fact] }).events).toEqual(
          []
        );
      }
    }
    // Closed, reopened and closed again: the second closure is a new fact.
    const closed = { ...green, prState: 'CLOSED' as const, observedAt: at(1) };
    const closing = reduce(closed, green, { hashIdentity });
    const deliveredEvents = [{ ...closing.events[0]!, id: 'closure' }];
    const ledger = { hashIdentity, deliveredEvents };
    for (const baseline of [closing.storedObservation, null]) {
      const reopened = reduce({ ...green, observedAt: at(2) }, baseline, {
        ...ledger,
        transitionSequence: closing.nextTransitionSequence,
      });
      expect(reopened.nextTransitionSequence).toBe(closing.nextTransitionSequence + 1);
      const closedAgain = reduce({ ...closed, observedAt: at(3) }, null, {
        ...ledger,
        transitionSequence: reopened.nextTransitionSequence,
      });
      expect(kindsOf(closedAgain)).toEqual(['PR_CLOSED']);
    }
  });
});

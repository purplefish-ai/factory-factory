import { describe, expect, it } from 'vitest';
import { redObservation } from './pr-monitoring.test-helpers';
import { reducePRObservation } from './pr-trigger-policy';
import type { PRObservation } from './schemas/pr-event.schema';

/**
 * Facts the ledger decides: what is restated when the reducer has no usable
 * baseline, and whether a failure whose failing checks changed and changed
 * back was already announced. See
 * docs/decisions/2026-11-22-pr-facts-restart-from-the-ledger.md.
 */
const target = { workspaceId: 'w', prId: 'p' };

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

const at = (minute: number) => `2026-10-08T00:${String(minute).padStart(2, '0')}:00.000Z`;
const kindsOf = (reduction: ReturnType<typeof reduce>) => reduction.events.map((e) => e.kind);

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
    const changed = { ...again, checks: [failed, { ...failed, identity: 'run-3', name: 'lint' }] };
    expect(kindsOf(reduce(changed, null, { deliveredEvents: [announced] }))).toEqual(['CI_FAILED']);
  });

  it('keeps a failure announced when the baseline is lost before its run finishes', () => {
    // The failure was announced at the 30-minute limit while a check kept running.
    const unsettled = { ...redObservation, checks: [failed, running] };
    const opened = reduce(unsettled);
    expect(opened.events).toEqual([]);
    const overdue = reduce({ ...unsettled, observedAt: at(30) }, opened.storedObservation);
    expect(kindsOf(overdue)).toEqual(['CI_FAILED']);
    const delivered = { deliveredEvents: [{ ...overdue.events[0]!, id: 'overdue' }] };
    const lost = reduce({ ...unsettled, observedAt: at(40) }, null, delivered);
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

  it('keeps feedback in flight through a lost baseline and an incomplete read', () => {
    // The other facts were received; the feedback is claimed but not yet received.
    const received = facts('told').filter((e) => e.kind !== 'REVIEW_FEEDBACK');
    const claimed = facts('claimed').filter((e) => e.kind === 'REVIEW_FEEDBACK');
    const ledger = { ...after, deliveredEvents: received, inFlightEvents: claimed };
    const unread = { ...open, actionableReviews: [], reviewsComplete: false, observedAt: at(1) };
    const lost = reduce(unread, null, ledger);
    expect(lost.events).toEqual([]);
    expect(lost.storedObservation.actionableReviews).toEqual([review]);
    // Receipt recovery proves the claim absent and requeues the fact under its key;
    // the next complete read neither drops nor repeats it.
    const requeued = claimed.map((e) => ({ ...e, id: 'requeued' }));
    const read = reduce({ ...open, observedAt: at(2) }, lost.storedObservation, {
      deliveredEvents: received,
      pendingEvents: requeued,
      transitionSequence: lost.nextTransitionSequence,
    });
    expect(read).toMatchObject({ events: [], supersededEventIds: [] });
    // Claimed for an earlier head, a requeued copy would be superseded, so it is stated again.
    const pushed = { ...unread, headSha: 'head-2' };
    expect(kindsOf(reduce(pushed, null, ledger))).toContain('REVIEW_FEEDBACK');
  });

  it('ignores ledger rows of another epoch, whose destination was another one', () => {
    expect(kindsOf(reduce(open, null, { eventEpoch: 2, deliveredEvents: facts('old') }))).toEqual(
      everything
    );
    // Nor does a delivered failure of another epoch get a recovery in this one.
    const green = { ...redObservation, ciStatus: 'SUCCESS' as const, checks: [] };
    const old = { eventEpoch: 2, deliveredEvents: facts('old') };
    expect(reduce(green, redObservation, old).events).toEqual([]);
  });

  it('does not take a row without a deduplication key for this epoch', () => {
    const unkeyed = facts('unkeyed').map(({ deduplicationKey: _key, ...e }) => e);
    expect(kindsOf(reduce(open, null, { deliveredEvents: unkeyed }))).toEqual(everything);
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
      // Observed open again without a baseline, as with one, the sequence advances.
      const open = { ...green, observedAt: at(2) };
      const after = { hashIdentity, deliveredEvents: [fact] };
      for (const baseline of [ending.storedObservation, null]) {
        expect(
          reduce(open, baseline, { ...after, transitionSequence: ending.nextTransitionSequence })
            .nextTransitionSequence
        ).toBe(ending.nextTransitionSequence + 1);
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

describe('a failure whose failing checks change and change back', () => {
  // F2 is the test check failing; F3 adds a lint failure, which a re-run then clears.
  const test = redObservation.checks[0]!;
  const lint = { ...test, identity: 'run-2', name: 'lint', completedAt: at(2) };
  const f2 = reduce(redObservation);
  const toldF2 = [{ ...f2.events[0]!, id: 'f2' }];
  const f3 = { ...redObservation, checks: [test, lint], observedAt: at(2) };
  const back = { ...f3, checks: [test, { ...lint, conclusion: 'SUCCESS' }], observedAt: at(3) };
  const green = { ...redObservation, ciStatus: 'SUCCESS' as const, checks: [], observedAt: at(1) };

  function throughF3(previous: PRObservation, ledger: Parameters<typeof reduce>[2]) {
    const more = reduce(f3, previous, ledger);
    expect(kindsOf(more)).toEqual(['CI_FAILED']);
    return { more, queued: { ...more.events[0]!, id: 'f3' } };
  }

  it.each(['deliveredEvents', 'inFlightEvents'] as const)(
    'does not announce again the failure the recipient was last told of (%s)',
    (told) => {
      const { more, queued } = throughF3(f2.storedObservation, { [told]: toldF2 });
      const returned = reduce(back, more.storedObservation, {
        [told]: toldF2,
        pendingEvents: [queued],
        transitionSequence: more.nextTransitionSequence,
      });
      expect(returned).toMatchObject({ events: [], supersededEventIds: ['f3'] });
      expect(returned.storedObservation.ciFailure).toEqual({ since: at(3), announced: true });
      const later = { ...back, observedAt: at(4) };
      expect(reduce(later, returned.storedObservation, { [told]: toldF2 }).events).toEqual([]);
    }
  );

  it('announces it again when the recipient was last told of another failure or a recovery', () => {
    const { more, queued } = throughF3(f2.storedObservation, { deliveredEvents: toldF2 });
    const toldF3 = [...toldF2, queued];
    expect(
      kindsOf(
        reduce(back, more.storedObservation, {
          deliveredEvents: toldF3,
          transitionSequence: more.nextTransitionSequence,
        })
      )
    ).toEqual(['CI_FAILED']);
    const recovery = {
      ...reduce(green, f2.storedObservation, { deliveredEvents: toldF2 }).events[0]!,
      id: 'recovered',
    };
    expect(recovery.kind).toBe('CI_RECOVERED');
    const afterRecovery = throughF3(green, {
      deliveredEvents: [...toldF2, recovery],
      transitionSequence: 2,
    });
    const returned = reduce(back, afterRecovery.more.storedObservation, {
      deliveredEvents: [...toldF2, recovery],
      pendingEvents: [afterRecovery.queued],
      transitionSequence: afterRecovery.more.nextTransitionSequence,
    });
    expect(kindsOf(returned)).toEqual(['CI_FAILED']);
  });

  it('does not announce it again after a recovery that was superseded undelivered', () => {
    // CI passed and failed again before the recovery arrived, so the recipient
    // still believes F2 fails, which is true again once the lint failure clears.
    const recovery = {
      ...reduce(green, f2.storedObservation, { deliveredEvents: toldF2 }).events[0]!,
      id: 'recovered',
    };
    const failedAgain = reduce(f3, green, {
      deliveredEvents: toldF2,
      pendingEvents: [recovery],
      transitionSequence: 2,
    });
    expect(failedAgain.supersededEventIds).toEqual(['recovered']);
    expect(kindsOf(failedAgain)).toEqual(['CI_FAILED']);
    const queued = { ...failedAgain.events[0]!, id: 'f3' };
    const returned = reduce(back, failedAgain.storedObservation, {
      deliveredEvents: toldF2,
      pendingEvents: [queued],
      transitionSequence: failedAgain.nextTransitionSequence,
    });
    expect(returned).toMatchObject({ events: [], supersededEventIds: ['f3'] });
  });
});

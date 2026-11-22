import type { PRFactDraft, PREventSummary } from './pr-trigger-policy.types';
import type {
  PRFactPayload,
  PRObservation,
  PRStoredObservation,
  PRTarget,
} from './schemas/pr-event.schema';

const failures = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ERROR',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);
/** Check statuses that are not terminal, as `core/ci-status` classifies them. */
const running = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);
/**
 * A failing run with no check still in progress. A failure is announced then,
 * so one run yields one update however many of its checks fail.
 */
export function isSettledPRFailure(observation: PRObservation): boolean {
  return (
    observation.ciStatus === 'FAILURE' &&
    !observation.checks.some((c) => running.has(c.status.toUpperCase()))
  );
}
/**
 * How long an unchanged failure waits for its run to finish. A check can stay
 * in progress indefinitely (a job awaiting approval, a required status nobody
 * reports), and the failure beside it must still be announced.
 */
export const PR_FAILURE_MAX_WAIT_MS = 30 * 60_000;
export function prFailureSignature(observation: PRObservation): string {
  return JSON.stringify(
    observation.checks
      .filter((c) => failures.has(c.conclusion?.toUpperCase() ?? ''))
      .map((c) => [
        c.identity,
        c.attempt,
        c.name,
        c.workflowName,
        c.detailsUrl,
        c.startedAt,
        c.completedAt,
        c.conclusion,
      ])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  );
}

type ReductionInput = Parameters<typeof reducePRObservation>[0];
type Fact =
  | { kind: Exclude<PRFactPayload['kind'], 'REVIEW_FEEDBACK'> }
  | Pick<Extract<PRFactPayload, { kind: 'REVIEW_FEEDBACK' }>, 'kind' | 'reviews'>;
type AddFact = (fact: Fact, identity: string) => void;
/** The ledger as this observation leaves it. */
type Ledger = {
  /** Unclaimed facts this observation did not supersede. */
  pending: readonly PREventSummary[];
  /** Facts the recipient has received or is receiving. */
  told: readonly PREventSummary[];
};

export function reducePRObservation(input: {
  target: PRTarget;
  /** The stored observation of this epoch, or null on its first observation. */
  previous: PRStoredObservation | null;
  current: PRObservation;
  transitionSequence: number;
  eventEpoch: number;
  pendingEvents: readonly PREventSummary[];
  deliveredEvents: readonly PREventSummary[];
  inFlightEvents?: readonly PREventSummary[];
  hashIdentity?: (identity: string) => string;
}) {
  const { target, previous, current, eventEpoch, pendingEvents, deliveredEvents } = input;
  const events: PRFactDraft[] = [];
  let nextTransitionSequence = input.transitionSequence;
  const prefix = `${target.prId}:epoch:${eventEpoch}:`;
  const inFlightEvents = input.inFlightEvents ?? [];
  const known = [...pendingEvents, ...deliveredEvents, ...inFlightEvents];
  const observation = factObservation(current);
  // Every identity embeds the sequence after it is advanced, so a key is never generated twice.
  const add: AddFact = (fact, identity) => {
    const deduplicationKey = `${prefix}${input.hashIdentity ? input.hashIdentity(identity) : identity}`;
    if (!known.some((e) => e.deduplicationKey === deduplicationKey)) {
      events.push({ kind: fact.kind, deduplicationKey, payload: { ...fact, target, observation } });
    }
  };
  const terminal = current.prState === 'MERGED' || current.prState === 'CLOSED';
  const supersededEventIds = pendingEvents
    .filter((event) => eventIsSuperseded(event, current, terminal, deliveredEvents))
    .map((event) => event.id);
  const storedObservation = nextStoredObservation(previous, current, terminal);
  if (terminal) {
    if (previous?.prState !== current.prState) {
      nextTransitionSequence++;
      add(
        { kind: current.prState === 'MERGED' ? 'PR_MERGED' : 'PR_CLOSED' },
        `${current.prState}:${nextTransitionSequence}`
      );
    }
    return { events, supersededEventIds, nextTransitionSequence, storedObservation };
  }
  if (previous && ['MERGED', 'CLOSED'].includes(previous.prState)) {
    nextTransitionSequence++;
  }
  const ledger: Ledger = {
    pending: pendingEvents.filter((event) => !supersededEventIds.includes(event.id)),
    told: [...deliveredEvents, ...inFlightEvents],
  };
  nextTransitionSequence = addCITransition(input, add, nextTransitionSequence, ledger);
  nextTransitionSequence = addConflictTransition(input, add, nextTransitionSequence, ledger);
  nextTransitionSequence = addReviewTransitions(
    input,
    add,
    nextTransitionSequence,
    storedObservation.actionableReviews
  );
  return { events, supersededEventIds, nextTransitionSequence, storedObservation };
}

/**
 * A fact carries the observation it was derived from without the review list:
 * a feedback fact names its own review, and no reader uses the rest.
 */
function factObservation(current: PRObservation): PRObservation {
  const { resolvedReviewIds: _resolvedReviewIds, ...facts } = current;
  return { ...facts, actionableReviews: [] };
}

/**
 * What is remembered of the current failure: carried from `previous` while the
 * head and the failing checks are unchanged, and started afresh otherwise.
 */
function failureMemory(
  previous: PRStoredObservation | null,
  current: PRObservation,
  terminal: boolean
) {
  const carried =
    previous &&
    previous.ciStatus === 'FAILURE' &&
    previous.headSha === current.headSha &&
    prFailureSignature(previous) === prFailureSignature(current)
      ? (previous.ciFailure ?? { since: previous.observedAt, announced: true })
      : null;
  const since = carried?.since ?? current.observedAt;
  const due =
    !terminal &&
    (isSettledPRFailure(current) ||
      Date.parse(current.observedAt) - Date.parse(since) >= PR_FAILURE_MAX_WAIT_MS);
  return { since, announced: carried?.announced ?? false, due };
}

/**
 * The observation to store as the next baseline. An incomplete review read keeps
 * the feedback this epoch already observed, unless it is known to be resolved or
 * was read again; `previous` is null in a new epoch, so nothing crosses one.
 */
function nextStoredObservation(
  previous: PRStoredObservation | null,
  current: PRObservation,
  terminal: boolean
): PRStoredObservation {
  const failure =
    current.ciStatus === 'FAILURE' ? failureMemory(previous, current, terminal) : null;
  const stored: PRStoredObservation = failure
    ? {
        ...current,
        ciFailure: { since: failure.since, announced: failure.announced || failure.due },
      }
    : current;
  if (current.reviewsComplete || !previous) {
    return stored;
  }
  return {
    ...stored,
    actionableReviews: [
      ...current.actionableReviews,
      ...previous.actionableReviews.filter(
        (r) =>
          !(
            current.resolvedReviewIds?.includes(r.identity) ||
            current.actionableReviews.some((c) => c.identity === r.identity)
          )
      ),
    ],
  };
}

/** The most recently observed of `events`; ledger order breaks a tie. */
function latest(events: readonly PREventSummary[]): PREventSummary | undefined {
  let newest: PREventSummary | undefined;
  for (const event of events) {
    const order = newest
      ? event.payload.observation.observedAt.localeCompare(newest.payload.observation.observedAt) ||
        (event.createdAt?.getTime() ?? 0) - (newest.createdAt?.getTime() ?? 0)
      : 1;
    if (order >= 0) {
      newest = event;
    }
  }
  return newest;
}

function sameReview(
  a: { identity: string; contentHash: string },
  b: { identity: string; contentHash: string }
) {
  return a.identity === b.identity && a.contentHash === b.contentHash;
}

function deliveredReviews(deliveredEvents: readonly PREventSummary[]) {
  return deliveredEvents.flatMap((e) =>
    e.payload.kind === 'REVIEW_FEEDBACK' ? e.payload.reviews : []
  );
}

/**
 * A delivery received after this event was queued, i.e. one in flight when it
 * was re-emitted. Ties are safe: the reducer only queues a review that is not
 * already delivered, so a same-instant delivery of it is that in-flight one.
 */
function receivedSince(event: PREventSummary, deliveredEvents: readonly PREventSummary[]) {
  const queuedAt = event.createdAt;
  return queuedAt ? deliveredEvents.filter((d) => d.deliveredAt && d.deliveredAt >= queuedAt) : [];
}

/** A queued fact is dropped once the head moved or what it reports stopped being true. */
function eventIsSuperseded(
  event: PREventSummary,
  current: PRObservation,
  terminal: boolean,
  deliveredEvents: readonly PREventSummary[]
): boolean {
  const payload = event.payload;
  if (payload.observation.headSha !== current.headSha) {
    return true;
  }
  if (terminal && !['PR_MERGED', 'PR_CLOSED'].includes(event.kind)) {
    return true;
  }
  if (event.kind === 'PR_CLOSED') {
    return current.prState !== 'CLOSED';
  }
  if (event.kind === 'CI_FAILED') {
    return (
      current.ciStatus === 'SUCCESS' ||
      (current.ciStatus === 'FAILURE' &&
        prFailureSignature(payload.observation) !== prFailureSignature(current))
    );
  }
  if (event.kind === 'CI_RECOVERED') {
    return current.ciStatus === 'FAILURE';
  }
  if (event.kind === 'CONFLICT_DETECTED') {
    return !current.hasMergeConflict;
  }
  if (event.kind === 'CONFLICT_CLEARED') {
    return current.hasMergeConflict;
  }
  if (payload.kind !== 'REVIEW_FEEDBACK') {
    return false;
  }
  // Feedback re-emitted while an earlier delivery was in flight is dropped once
  // that delivery is received; until then it guards against a cancelled claim.
  // Deliveries received before this event was queued (e.g. a re-opened thread)
  // do not suppress it.
  const delivered = deliveredReviews(receivedSince(event, deliveredEvents));
  return (
    (payload.reviews.length > 0 &&
      payload.reviews.every((r) => delivered.some((d) => sameReview(d, r)))) ||
    payload.reviews.some(
      (r) =>
        current.resolvedReviewIds?.includes(r.identity) ||
        (current.reviewsComplete && !current.actionableReviews.some((c) => sameReview(c, r)))
    )
  );
}
function addCITransition(input: ReductionInput, add: AddFact, sequence: number, ledger: Ledger) {
  const { previous, current, deliveredEvents } = input;
  if (current.ciStatus === 'FAILURE') {
    const signature = prFailureSignature(current);
    const queued = ledger.pending.some(
      (e) =>
        e.kind === 'CI_FAILED' &&
        e.payload.observation.headSha === current.headSha &&
        prFailureSignature(e.payload.observation) === signature
    );
    const failure = failureMemory(previous, current, false);
    if (failure.due && !failure.announced && !queued) {
      sequence++;
      add({ kind: 'CI_FAILED' }, `CI_FAILED:${current.headSha}:${sequence}:${signature}`);
    }
  } else if (current.ciStatus === 'SUCCESS') {
    const failure = latest(
      deliveredEvents.filter(
        (e) => e.kind === 'CI_FAILED' && e.payload.observation.headSha === current.headSha
      )
    );
    if (!failure) {
      return sequence;
    }
    // One recovery per delivered failure: a live recovery observed after it already reports this.
    const reported = [...ledger.pending, ...ledger.told].some(
      (e) =>
        e.kind === 'CI_RECOVERED' &&
        e.payload.observation.headSha === current.headSha &&
        e.payload.observation.observedAt >= failure.payload.observation.observedAt
    );
    if (!reported) {
      sequence++;
      add(
        { kind: 'CI_RECOVERED' },
        `CI_RECOVERED:${current.headSha}:${failure.deduplicationKey ?? failure.id}:${sequence}`
      );
    }
  }
  return sequence;
}

function addReviewTransitions(
  input: ReductionInput,
  add: AddFact,
  sequence: number,
  actionableReviews: PRStoredObservation['actionableReviews']
) {
  const { previous, current } = input;
  // A new head supersedes undelivered feedback, so it is re-emitted; delivered
  // feedback is unchanged and is not repeated. Feedback frozen in flight is
  // re-emitted too, because a cancelled claim would otherwise lose it. The
  // reviews are the stored ones, so feedback an incomplete read kept is also
  // re-emitted on a new head instead of being adopted by it unannounced.
  const delivered = deliveredReviews(input.deliveredEvents);
  for (const review of actionableReviews) {
    if (
      !previous?.actionableReviews.some((r) => sameReview(r, review)) ||
      (previous.headSha !== current.headSha && !delivered.some((r) => sameReview(r, review)))
    ) {
      sequence++;
      add(
        { kind: 'REVIEW_FEEDBACK', reviews: [review] },
        `REVIEW:${current.headSha}:${review.identity}:${review.contentHash}:${sequence}`
      );
    }
  }
  return sequence;
}

function addConflictTransition(
  input: ReductionInput,
  add: AddFact,
  sequence: number,
  ledger: Ledger
) {
  const { previous, current } = input;
  // The recipient believes the PR is conflicted while the last conflict fact it got says so.
  const told =
    latest(
      ledger.told.filter((e) => e.kind === 'CONFLICT_DETECTED' || e.kind === 'CONFLICT_CLEARED')
    )?.kind === 'CONFLICT_DETECTED';
  const changed = current.hasMergeConflict !== (previous?.hasMergeConflict ?? false);
  // A new head supersedes an undelivered conflict fact, so it is re-emitted.
  const headMoved = !!previous && previous.headSha !== current.headSha;
  if (current.hasMergeConflict ? changed || (headMoved && !told) : told && (changed || headMoved)) {
    sequence++;
    add(
      { kind: current.hasMergeConflict ? 'CONFLICT_DETECTED' : 'CONFLICT_CLEARED' },
      `CONFLICT:${current.hasMergeConflict}:${sequence}`
    );
  }
  return sequence;
}

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
/** This epoch's ledger as this observation leaves it. */
type Ledger = {
  /** Unclaimed facts this observation did not supersede. */
  pending: readonly PREventSummary[];
  /** Facts the recipient has received or is receiving. */
  told: readonly PREventSummary[];
  /** Facts the recipient has received. */
  delivered: readonly PREventSummary[];
  /**
   * Set when there is no usable baseline: no readable stored observation in
   * this epoch, or a merged or closed one while the PR is open. The comparison
   * then restarts, and a fact that holds is stated unless the ledger shows it
   * was told or queued.
   */
  restart: boolean;
};

const isTerminal = (state: PRObservation['prState']) => state === 'MERGED' || state === 'CLOSED';

export function reducePRObservation(input: {
  target: PRTarget;
  /**
   * The stored observation of this epoch, or null on its first observation or
   * when the stored one cannot be read.
   */
  previous: PRStoredObservation | null;
  current: PRObservation;
  transitionSequence: number;
  eventEpoch: number;
  pendingEvents: readonly PREventSummary[];
  deliveredEvents: readonly PREventSummary[];
  inFlightEvents?: readonly PREventSummary[];
  hashIdentity?: (identity: string) => string;
}) {
  const { target, previous, current, pendingEvents, deliveredEvents } = input;
  const events: PRFactDraft[] = [];
  let nextTransitionSequence = input.transitionSequence;
  const prefix = `${target.prId}:epoch:${input.eventEpoch}:`;
  const keyOf = (identity: string) =>
    `${prefix}${input.hashIdentity ? input.hashIdentity(identity) : identity}`;
  const known = [...pendingEvents, ...deliveredEvents, ...(input.inFlightEvents ?? [])];
  const observation = factObservation(current);
  // Every identity embeds the sequence after it is advanced, so a key is never generated twice.
  const add: AddFact = (fact, identity) => {
    const deduplicationKey = keyOf(identity);
    if (!known.some((e) => e.deduplicationKey === deduplicationKey)) {
      events.push({ kind: fact.kind, deduplicationKey, payload: { ...fact, target, observation } });
    }
  };
  // The last transition this epoch recorded is the PR becoming `state`: no sequence advanced since.
  const lastTransitionWas = (state: string) =>
    known.some((e) => e.deduplicationKey === keyOf(`${state}:${input.transitionSequence}`));
  const terminal = isTerminal(current.prState);
  const supersededEventIds = pendingEvents
    .filter((event) => eventIsSuperseded(event, current, terminal, deliveredEvents))
    .map((event) => event.id);
  const ledger = epochLedger(input, prefix, supersededEventIds);
  const storedObservation = nextStoredObservation(previous, current, terminal, ledger);
  if (terminal) {
    if (previous ? previous.prState !== current.prState : !lastTransitionWas(current.prState)) {
      nextTransitionSequence++;
      add(
        { kind: current.prState === 'MERGED' ? 'PR_MERGED' : 'PR_CLOSED' },
        `${current.prState}:${nextTransitionSequence}`
      );
    }
    return { events, supersededEventIds, nextTransitionSequence, storedObservation };
  }
  // A reopening is a transition, so a later closure is a new fact even without a baseline.
  if (previous ? isTerminal(previous.prState) : lastTransitionWas('CLOSED')) {
    nextTransitionSequence++;
  }
  nextTransitionSequence = addCITransition(input, add, nextTransitionSequence, ledger);
  nextTransitionSequence = addConflictTransition(input, add, nextTransitionSequence, ledger);
  nextTransitionSequence = addReviewTransitions(
    input,
    add,
    nextTransitionSequence,
    storedObservation.actionableReviews,
    ledger
  );
  return { events, supersededEventIds, nextTransitionSequence, storedObservation };
}

/**
 * The ledger rows of this epoch. The accessor reads no other, so this only
 * matters to a caller that hands over rows keyed for another epoch or PR: they
 * describe what an earlier destination was told, not this one.
 */
function epochLedger(
  input: ReductionInput,
  prefix: string,
  supersededEventIds: readonly string[]
): Ledger {
  const ofEpoch = (event: PREventSummary) => event.deduplicationKey?.startsWith(prefix) ?? true;
  const delivered = input.deliveredEvents.filter(ofEpoch);
  return {
    pending: input.pendingEvents.filter((e) => ofEpoch(e) && !supersededEventIds.includes(e.id)),
    told: [...delivered, ...(input.inFlightEvents ?? []).filter(ofEpoch)],
    delivered,
    restart:
      !isTerminal(input.current.prState) && (!input.previous || isTerminal(input.previous.prState)),
  };
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
 * head and the failing checks are unchanged, and started afresh otherwise. On a
 * restart the ledger, not the memory, says whether it was announced: a closure
 * supersedes a queued announcement, and a lost baseline forgets a delivered one.
 */
function failureMemory(
  previous: PRStoredObservation | null,
  current: PRObservation,
  terminal: boolean,
  ledger: Ledger
) {
  const failing =
    previous?.ciStatus === 'FAILURE' && previous.headSha === current.headSha ? previous : null;
  const carried =
    failing && prFailureSignature(failing) === prFailureSignature(current)
      ? (failing.ciFailure ?? { since: failing.observedAt, announced: true })
      : null;
  const since = carried?.since ?? current.observedAt;
  const due =
    !terminal &&
    (isSettledPRFailure(current) ||
      Date.parse(current.observedAt) - Date.parse(since) >= PR_FAILURE_MAX_WAIT_MS);
  return { since, announced: failureAnnounced(ledger, current, failing, carried), due };
}

/**
 * Whether the current failure was announced. On a restart the ledger says so.
 * When the failing checks changed while CI kept failing, the failure is already
 * announced if the last CI fact the recipient was told for this head reports it:
 * an announcement of the checks in between was superseded before it arrived. A
 * queued fact does not count, because a requeued one would only be superseded
 * again. When CI stopped failing in between, the failure is announced afresh.
 */
function failureAnnounced(
  ledger: Ledger,
  current: PRObservation,
  failing: PRStoredObservation | null,
  carried: { announced: boolean } | null
) {
  if (ledger.restart) {
    return lastFailureIs([...ledger.pending, ...ledger.told], current);
  }
  if (carried) {
    return carried.announced;
  }
  return !!failing && lastFailureIs(ledger.told, current);
}

/**
 * The last CI fact among `events` for this head reports this failure, and no
 * recovery has answered it since.
 */
function lastFailureIs(events: readonly PREventSummary[], current: PRObservation) {
  const last = latest(
    events.filter(
      (e) =>
        (e.kind === 'CI_FAILED' || e.kind === 'CI_RECOVERED') &&
        e.payload.observation.headSha === current.headSha
    )
  );
  return (
    last?.kind === 'CI_FAILED' &&
    prFailureSignature(last.payload.observation) === prFailureSignature(current)
  );
}

/**
 * The observation to store as the next baseline. An incomplete review read keeps
 * the feedback this epoch already observed, unless it is known to be resolved or
 * was read again; `previous` is null in a new epoch, so nothing crosses one.
 * Without a stored observation, the feedback this epoch's ledger states is kept,
 * so the next complete read does not take it for new.
 */
function nextStoredObservation(
  previous: PRStoredObservation | null,
  current: PRObservation,
  terminal: boolean,
  ledger: Ledger
): PRStoredObservation {
  const failure =
    current.ciStatus === 'FAILURE' ? failureMemory(previous, current, terminal, ledger) : null;
  const stored: PRStoredObservation = failure
    ? {
        ...current,
        ciFailure: { since: failure.since, announced: failure.announced || failure.due },
      }
    : current;
  if (current.reviewsComplete) {
    return stored;
  }
  const kept = previous ? previous.actionableReviews : statedReviews(ledger);
  return {
    ...stored,
    actionableReviews: [
      ...current.actionableReviews,
      ...kept.filter(
        (r) =>
          !(
            current.resolvedReviewIds?.includes(r.identity) ||
            current.actionableReviews.some((c) => c.identity === r.identity)
          )
      ),
    ],
  };
}

/** Each review the ledger shows told or queued, once. */
function statedReviews(ledger: Ledger) {
  const reviews = reviewsOf([...ledger.pending, ...ledger.told]);
  return reviews.filter((r, i) => reviews.findIndex((o) => sameReview(o, r)) === i);
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

function reviewsOf(events: readonly PREventSummary[]) {
  return events.flatMap((e) => (e.payload.kind === 'REVIEW_FEEDBACK' ? e.payload.reviews : []));
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
  const delivered = reviewsOf(receivedSince(event, deliveredEvents));
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
    const failure = failureMemory(previous, current, false, ledger);
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

type Review = PRStoredObservation['actionableReviews'][number];

/**
 * A new head supersedes undelivered feedback, so it is re-emitted; delivered
 * feedback is unchanged and is not repeated. Feedback frozen in flight is
 * re-emitted too, because a cancelled claim would otherwise lose it. The
 * reviews are the stored ones, so feedback an incomplete read kept is also
 * re-emitted on a new head instead of being adopted by it unannounced.
 */
function reviewIsNew(input: ReductionInput, review: Review) {
  const { previous, current } = input;
  return (
    !previous?.actionableReviews.some((r) => sameReview(r, review)) ||
    (previous.headSha !== current.headSha &&
      !reviewsOf(input.deliveredEvents).some((r) => sameReview(r, review)))
  );
}

/**
 * On a restart, feedback is stated unless it was delivered, or is queued or in
 * flight for this head. Feedback in flight for an earlier head is stated again
 * for the reason `reviewIsNew` gives.
 */
function reviewIsStated(ledger: Ledger, current: PRObservation, review: Review) {
  return [...ledger.pending, ...ledger.told].some(
    (e) =>
      reviewsOf([e]).some((r) => sameReview(r, review)) &&
      (e.payload.observation.headSha === current.headSha || ledger.delivered.includes(e))
  );
}

function addReviewTransitions(
  input: ReductionInput,
  add: AddFact,
  sequence: number,
  actionableReviews: readonly Review[],
  ledger: Ledger
) {
  const { current } = input;
  for (const review of actionableReviews) {
    if (ledger.restart ? !reviewIsStated(ledger, current, review) : reviewIsNew(input, review)) {
      sequence++;
      add(
        { kind: 'REVIEW_FEEDBACK', reviews: [review] },
        `REVIEW:${current.headSha}:${review.identity}:${review.contentHash}:${sequence}`
      );
    }
  }
  return sequence;
}

/**
 * Whether a conflict fact is due. On a restart the queue is made to agree with
 * what the recipient believes: a detection when it believes the PR is clean, a
 * clearance when it believes it conflicted, unless that fact is already queued.
 */
function conflictFactIsDue(input: ReductionInput, ledger: Ledger) {
  const { previous, current } = input;
  // The recipient believes the PR is conflicted while the last conflict fact it got says so.
  const told =
    latest(
      ledger.told.filter((e) => e.kind === 'CONFLICT_DETECTED' || e.kind === 'CONFLICT_CLEARED')
    )?.kind === 'CONFLICT_DETECTED';
  if (ledger.restart) {
    const kind = current.hasMergeConflict ? 'CONFLICT_DETECTED' : 'CONFLICT_CLEARED';
    return told !== current.hasMergeConflict && !ledger.pending.some((e) => e.kind === kind);
  }
  const changed = current.hasMergeConflict !== (previous?.hasMergeConflict ?? false);
  // A new head supersedes an undelivered conflict fact, so it is re-emitted.
  const headMoved = !!previous && previous.headSha !== current.headSha;
  return current.hasMergeConflict
    ? changed || (headMoved && !told)
    : told && (changed || headMoved);
}

function addConflictTransition(
  input: ReductionInput,
  add: AddFact,
  sequence: number,
  ledger: Ledger
) {
  const { current } = input;
  if (conflictFactIsDue(input, ledger)) {
    sequence++;
    add(
      { kind: current.hasMergeConflict ? 'CONFLICT_DETECTED' : 'CONFLICT_CLEARED' },
      `CONFLICT:${current.hasMergeConflict}:${sequence}`
    );
  }
  return sequence;
}

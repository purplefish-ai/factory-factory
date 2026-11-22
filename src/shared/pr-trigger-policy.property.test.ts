import { expect, it } from 'vitest';
import { deriveCiStatusFromCheckRollup } from './core';
import { redObservation } from './pr-monitoring.test-helpers';
import {
  PR_FAILURE_MAX_WAIT_MS,
  prFailureSignature,
  reducePRObservation,
} from './pr-trigger-policy';
import type { PREventSummary } from './pr-trigger-policy.types';
import type { PRObservation, PRStoredObservation } from './schemas/pr-event.schema';

/**
 * Replays random histories of one open PR (pushes, check results, conflicts,
 * review threads) against a ledger whose facts are claimed and received at
 * random, and checks after every observation that the recipient has been told,
 * or has queued, exactly what is true now. A failure names the seed to replay.
 */
const SEEDS = 300;
const STEPS = 60;

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Check = { name: string; state: 'running' | 'failed' | 'passed'; completedAt: string | null };
type World = {
  head: number;
  checks: Check[];
  conflict: boolean;
  /** Open review threads by identity, with the revision of their text. */
  reviews: Map<string, number>;
  threads: number;
};
type Ledger = {
  previous: PRStoredObservation | null;
  pending: PREventSummary[];
  inFlight: PREventSummary[];
  delivered: PREventSummary[];
  sequence: number;
  keys: Set<string>;
  /** The failure observed without interruption, and when it was first seen. */
  failing: { key: string; since: number } | null;
};

const time = (tick: number) => new Date(Date.UTC(2026, 9, 8) + tick * 60_000);

type Pick = <T>(items: readonly T[]) => T | undefined;

function changeCheck(world: World, pick: Pick, addCheck: boolean, tick: number) {
  if (addCheck && world.checks.length < 3) {
    world.checks.push({ name: `c${world.checks.length}`, state: 'running', completedAt: null });
    return;
  }
  const check = pick(world.checks);
  if (check) {
    check.state = pick(['running', 'failed', 'failed', 'passed', 'passed'] as const) ?? 'running';
    check.completedAt = check.state === 'running' ? null : time(tick).toISOString();
  }
}

function changeReview(world: World, pick: Pick) {
  const open = pick([...world.reviews.keys()]);
  const change = pick(['open', 'open', 'edit', 'resolve']);
  if (change === 'open' || !open) {
    world.reviews.set(`comment:${world.threads++}`, 0);
  } else if (change === 'edit') {
    world.reviews.set(open, (world.reviews.get(open) ?? 0) + 1);
  } else {
    world.reviews.delete(open);
  }
}

function mutate(world: World, next: () => number, tick: number) {
  const pick: Pick = (items) => items[Math.floor(next() * items.length)];
  const action = pick(['push', 'check', 'check', 'check', 'conflict', 'review', 'review', 'none']);
  if (action === 'push') {
    world.head++;
    world.checks = next() < 0.2 ? [] : world.checks.map((c) => ({ ...c, state: 'running' }));
  } else if (action === 'check') {
    changeCheck(world, pick, next() < 0.4, tick);
  } else if (action === 'conflict') {
    world.conflict = !world.conflict;
  } else if (action === 'review') {
    changeReview(world, pick);
  }
}

function observation(world: World, tick: number, reviewsRead: boolean): PRObservation {
  const checks = world.checks.map((c) => ({
    identity: c.name,
    attempt: null,
    name: c.name,
    workflowName: null,
    status: c.state === 'running' ? 'IN_PROGRESS' : 'COMPLETED',
    conclusion: c.state === 'running' ? null : c.state === 'failed' ? 'FAILURE' : 'SUCCESS',
    detailsUrl: null,
    startedAt: null,
    completedAt: c.completedAt,
  }));
  return {
    ...redObservation,
    headSha: `head-${world.head}`,
    observedAt: time(tick).toISOString(),
    ciStatus: deriveCiStatusFromCheckRollup(checks),
    hasMergeConflict: world.conflict,
    checks,
    // An incomplete read (a rate limit, say) returns no reviews and resolves none.
    reviewsComplete: reviewsRead,
    actionableReviews: (reviewsRead ? [...world.reviews] : []).map(([identity, revision]) => ({
      identity,
      contentHash: `v${revision}`,
      author: 'reviewer',
      body: 'Please fix',
      path: null,
      line: null,
      url: redObservation.url,
      activityAt: redObservation.observedAt,
    })),
  };
}

function observe(ledger: Ledger, current: PRObservation, tick: number) {
  const reduction = reducePRObservation({
    target: { workspaceId: 'w', prId: 'p' },
    previous: ledger.previous,
    current,
    transitionSequence: ledger.sequence,
    eventEpoch: 1,
    pendingEvents: ledger.pending,
    deliveredEvents: ledger.delivered,
    inFlightEvents: ledger.inFlight,
  });
  expect(reduction.nextTransitionSequence).toBeGreaterThanOrEqual(ledger.sequence);
  ledger.sequence = reduction.nextTransitionSequence;
  ledger.previous = reduction.storedObservation;
  ledger.pending = ledger.pending.filter((e) => !reduction.supersededEventIds.includes(e.id));
  for (const event of reduction.events) {
    expect(ledger.keys.has(event.deduplicationKey)).toBe(false);
    ledger.keys.add(event.deduplicationKey);
    ledger.pending.push({ ...event, id: event.deduplicationKey, createdAt: time(tick) });
  }
  return reduction.events;
}

const ofKind = <T extends { kind: string }>(events: readonly T[], ...kinds: string[]) =>
  events.filter((e) => kinds.includes(e.kind));
const latest = (events: readonly PREventSummary[]) =>
  [...events]
    .sort((a, b) =>
      a.payload.observation.observedAt.localeCompare(b.payload.observation.observedAt)
    )
    .at(-1);
const reviewsIn = (events: readonly PREventSummary[]) =>
  events.flatMap((e) => (e.payload.kind === 'REVIEW_FEEDBACK' ? e.payload.reviews : []));

type Checked = {
  ledger: Ledger;
  current: PRObservation;
  emitted: readonly { kind: string }[];
  told: readonly PREventSummary[];
  live: readonly PREventSummary[];
  onHead: (event: PREventSummary) => boolean;
};

/** Queued facts describe the current head, and no kind is queued twice. */
function checkQueue({ ledger, onHead }: Checked) {
  expect(ledger.pending.every(onHead)).toBe(true);
  for (const kind of ['CI_FAILED', 'CI_RECOVERED', 'CONFLICT_DETECTED', 'CONFLICT_CLEARED']) {
    expect(ofKind(ledger.pending, kind).length).toBeLessThanOrEqual(1);
  }
}

/** The recipient believes what the last conflict fact it got says. */
function checkConflict({ ledger, current, told }: Checked) {
  const believesConflicted =
    latest(ofKind(told, 'CONFLICT_DETECTED', 'CONFLICT_CLEARED'))?.kind === 'CONFLICT_DETECTED';
  const queuedDetection = ofKind(ledger.pending, 'CONFLICT_DETECTED').length > 0;
  const queuedClearance = ofKind(ledger.pending, 'CONFLICT_CLEARED').length > 0;
  if (current.hasMergeConflict) {
    expect(believesConflicted || queuedDetection).toBe(true);
    expect(queuedClearance).toBe(false);
  } else {
    expect(queuedDetection).toBe(false);
    expect(queuedClearance).toBe(believesConflicted);
  }
}

/** A failing run is announced once it finishes or has waited long enough, not before. */
function checkFailure({ ledger, current, emitted, live, onHead }: Checked) {
  const signature = prFailureSignature(current);
  const key = current.ciStatus === 'FAILURE' ? `${current.headSha}:${signature}` : null;
  if (key !== (ledger.failing?.key ?? null)) {
    ledger.failing = key ? { key, since: Date.parse(current.observedAt) } : null;
  }
  if (!ledger.failing) {
    return;
  }
  expect(ofKind(ledger.pending, 'CI_RECOVERED')).toEqual([]);
  const running = current.checks.some((c) => c.status !== 'COMPLETED');
  const overdue = Date.parse(current.observedAt) - ledger.failing.since >= PR_FAILURE_MAX_WAIT_MS;
  if (running && !overdue) {
    expect(ofKind(emitted, 'CI_FAILED')).toEqual([]);
    return;
  }
  expect(
    ofKind(live, 'CI_FAILED').some(
      (e) => onHead(e) && prFailureSignature(e.payload.observation) === signature
    )
  ).toBe(true);
}

/** A passing run recovers the delivered failure of its head, and only that. */
function checkRecovery({ ledger, current, live, onHead }: Checked) {
  const failure = latest(ofKind(ledger.delivered, 'CI_FAILED').filter(onHead));
  if (!failure) {
    expect(ofKind(ledger.pending, 'CI_RECOVERED')).toEqual([]);
  }
  if (current.ciStatus !== 'SUCCESS') {
    return;
  }
  expect(ofKind(ledger.pending, 'CI_FAILED')).toEqual([]);
  const since = failure?.payload.observation.observedAt;
  expect(
    ofKind(live, 'CI_RECOVERED').some(
      (e) => onHead(e) && since !== undefined && e.payload.observation.observedAt >= since
    )
  ).toBe(failure !== undefined);
}

/** After a complete read, every open thread is told or queued and nothing resolved stays queued. */
function checkFeedback({ ledger, current, live }: Checked) {
  const same = (a: { identity: string; contentHash: string }) => (b: typeof a) =>
    a.identity === b.identity && a.contentHash === b.contentHash;
  const queued = reviewsIn(ledger.pending);
  expect(new Set(queued.map((r) => `${r.identity}:${r.contentHash}`)).size).toBe(queued.length);
  if (!current.reviewsComplete) {
    return;
  }
  for (const review of current.actionableReviews) {
    expect(reviewsIn(live).some(same(review))).toBe(true);
    expect(reviewsIn(ledger.pending).filter(same(review)).length).toBeLessThanOrEqual(1);
  }
  for (const review of reviewsIn(ledger.pending)) {
    expect(current.actionableReviews.some(same(review))).toBe(true);
  }
}

function check(ledger: Ledger, current: PRObservation, emitted: readonly { kind: string }[]) {
  const told = [...ledger.delivered, ...ledger.inFlight];
  const checked: Checked = {
    ledger,
    current,
    emitted,
    told,
    live: [...ledger.pending, ...told],
    onHead: (event) => event.payload.observation.headSha === current.headSha,
  };
  checkQueue(checked);
  checkConflict(checked);
  checkFailure(checked);
  checkRecovery(checked);
  checkFeedback(checked);
}

it('tells the recipient what is true of the PR, once, for random histories', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const next = random(seed);
    const world: World = { head: 1, checks: [], conflict: false, reviews: new Map(), threads: 0 };
    const ledger: Ledger = {
      previous: null,
      pending: [],
      inFlight: [],
      delivered: [],
      sequence: 0,
      keys: new Set(),
      failing: null,
    };
    for (let step = 0; step < STEPS; step++) {
      const tick = step * 3;
      mutate(world, next, tick);
      const delivery = next();
      if (delivery < 0.25 && ledger.inFlight.length === 0) {
        // Claim: the queued facts are frozen into one delivery.
        ledger.inFlight = ledger.pending;
        ledger.pending = [];
      } else if (delivery < 0.5) {
        // Receipt: the frozen delivery reached the recipient.
        ledger.delivered.push(
          ...ledger.inFlight.map((e) => ({ ...e, deliveredAt: time(tick + 1) }))
        );
        ledger.inFlight = [];
      }
      const current = observation(world, tick + 2, next() >= 0.25);
      const emitted = observe(ledger, current, tick + 2);
      try {
        check(ledger, current, emitted);
      } catch (error) {
        throw new Error(`seed ${seed}, step ${step}: ${String(error)}`, { cause: error });
      }
    }
  }
});

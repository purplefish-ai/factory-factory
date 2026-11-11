import { createHash } from 'node:crypto';
import type { PRObservation, PRTarget } from '@/shared/pr-monitoring';
import { hasPRObservation, shouldPollPR } from '@/shared/pr-polling';
import type { PRObservationPorts } from './pr-observation-ports';

/** Automatic observations reuse an accepted observation for this long. */
const RECENT_OBSERVATION_MS = 90_000;
/** Identical consecutive reads, after the first, before a settled PR backs off. */
export const STABLE_PR_REPEATS = 2;
/** Automatic cadence for a settled PR whose facts stopped changing. */
export const STABLE_PR_POLL_INTERVAL_MS = 10 * 60_000;

type RecentObservation = {
  revision: number;
  epoch: number;
  checkedAt: number;
  /** Hash of the accepted facts, excluding the observation time. */
  fingerprint: string;
  /** Consecutive unforced reads that returned the previous facts unchanged. */
  repeats: number;
  /** Open with terminal CI and, when requested, complete review facts. */
  settled: boolean;
};
type RecentObservations = Map<string, RecentObservation>;
/** `fetched` records whether the observation read GitHub or kept committed facts. */
type ObservationOutcome = { applied: boolean; fetched: boolean };
type InFlightObservation = { promise: Promise<ObservationOutcome>; forced: boolean };
const states = new WeakMap<
  object,
  { recent: RecentObservations; observing: Map<string, InFlightObservation> }
>();
function observationState(ports: PRObservationPorts) {
  let state = states.get(ports.cacheScope);
  if (!state) {
    state = { recent: new Map(), observing: new Map() };
    states.set(ports.cacheScope, state);
  }
  return state;
}
/** Whether an unforced observation can keep the committed facts without a GitHub read. */
function committedFactsAreCurrent(
  recent: RecentObservations,
  key: string,
  row: NonNullable<Awaited<ReturnType<PRObservationPorts['findPR']>>>,
  eventEpoch: number
): boolean {
  const cached = recent.get(key);
  if (cached?.revision === row.revision && cached.epoch === eventEpoch) {
    const age = Date.now() - cached.checkedAt;
    if (age < RECENT_OBSERVATION_MS) {
      return true;
    }
    if (cached.settled && cached.repeats >= STABLE_PR_REPEATS) {
      return age < STABLE_PR_POLL_INTERVAL_MS;
    }
  }
  return !shouldPollPR({ ...row, hasObservation: hasPRObservation(row.observation) }, eventEpoch);
}
function fingerprint(observation: PRObservation): string {
  const { observedAt: _observedAt, ...facts } = observation;
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}
function isSettled(observation: PRObservation, includeReviews: boolean): boolean {
  return (
    observation.prState !== 'MERGED' &&
    observation.prState !== 'CLOSED' &&
    (observation.ciStatus === 'SUCCESS' || observation.ciStatus === 'FAILURE') &&
    (observation.reviewsComplete || !includeReviews)
  );
}
/**
 * Return a workspace's PRs to the normal automatic cadence. Session activity
 * (an agent turn starting or finishing) is the usual sign that a push, and
 * therefore new CI and review activity, may follow.
 */
export function resetStablePRBackoff(ports: PRObservationPorts, workspaceId: string): void {
  const prefix = `${workspaceId}:`;
  for (const [key, entry] of observationState(ports).recent) {
    if (key.startsWith(prefix)) {
      entry.repeats = 0;
    }
  }
}
/**
 * Observe one attached PR. Unforced (automatic) observations are throttled: they
 * reuse an observation accepted in the last 90 seconds, apply the background
 * terminal-PR policy, so a committed MERGED (or recently checked CLOSED) PR is
 * not fetched again, and stretch a settled PR whose facts stopped changing to
 * `STABLE_PR_POLL_INTERVAL_MS`. `force` is reserved for explicit refreshes and
 * delivery freshness checks, which must always read GitHub; a forced read also
 * returns the PR to the normal cadence.
 */
export async function observeMonitoredPR(
  ports: PRObservationPorts,
  target: PRTarget,
  options?: { signal?: AbortSignal; force?: boolean }
): Promise<boolean> {
  const force = options?.force ?? false;
  const { recent, observing } = observationState(ports);
  const key = `${target.workspaceId}:${target.prId}`;
  let existing = observing.get(key);
  while (existing) {
    const outcome = await existing.promise;
    if (!force || existing.forced || outcome.fetched) {
      return outcome.applied;
    }
    // The in-flight automatic observation kept committed facts without reading
    // GitHub; an explicit refresh must still fetch, so start (or join) a forced one.
    const next = observing.get(key);
    existing = next === existing ? undefined : next;
  }
  const own: InFlightObservation = {
    promise: observeOnce(ports, target, recent, key, options),
    forced: force,
  };
  observing.set(key, own);
  try {
    return (await own.promise).applied;
  } finally {
    if (observing.get(key) === own) {
      observing.delete(key);
    }
  }
}
async function observeOnce(
  ports: PRObservationPorts,
  target: PRTarget,
  recent: RecentObservations,
  key: string,
  options?: { signal?: AbortSignal; force?: boolean }
): Promise<ObservationOutcome> {
  const signal = options?.signal;
  const [row, config] = await Promise.all([
    ports.findPR(target),
    ports.getMonitoring(target.workspaceId),
  ]);
  if (!(row && config)) {
    return { applied: false, fetched: false };
  }
  if (!options?.force && committedFactsAreCurrent(recent, key, row, config.eventEpoch)) {
    return { applied: true, fetched: false };
  }
  // Review data only feeds the event reducer, which creates no events while
  // monitoring is off. Enabling renews the epoch, so this review-less observation
  // is rejected if monitoring turns on before acceptance, and the new epoch's
  // first (full) observation becomes its baseline.
  const observation = await ports.fetchObservation(target, signal, {
    includeReviews: config.enabled,
  });
  signal?.throwIfAborted();
  const result = await ports.acceptObservation({
    target,
    expectedPrRevision: row.revision,
    expectedEventEpoch: config.eventEpoch,
    observation,
  });
  if (result.applied) {
    const previous = recent.get(key);
    const facts = fingerprint(observation);
    const unchanged =
      !options?.force &&
      previous?.revision === row.revision &&
      previous.epoch === config.eventEpoch &&
      previous.fingerprint === facts;
    recent.set(key, {
      revision: row.revision + 1,
      epoch: config.eventEpoch,
      checkedAt: Date.now(),
      fingerprint: facts,
      repeats: unchanged ? previous.repeats + 1 : 0,
      settled: isSettled(observation, config.enabled),
    });
    if (recent.size > 1000) {
      recent.delete(recent.keys().next().value ?? key);
    }
    ports.publishAcceptedObservation({
      workspaceId: target.workspaceId,
      prId: target.prId,
      prUrl: observation.url,
      prNumber: observation.number,
      prState: observation.prState,
      previousPrState: row.state,
      prCiStatus: observation.ciStatus,
      prReviewState: observation.reviewState,
      ...(result.eventIds.length ? { prEventsCreated: true as const } : {}),
    });
  }
  return { applied: result.applied, fetched: true };
}

import type { PRTarget } from '@/shared/pr-monitoring';
import { shouldPollPR } from '@/shared/pr-polling';
import type { PRObservationPorts } from './pr-observation-ports';
type RecentObservations = Map<string, { revision: number; epoch: number; checkedAt: number }>;
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
  if (
    cached?.revision === row.revision &&
    cached.epoch === eventEpoch &&
    Date.now() - cached.checkedAt < 90_000
  ) {
    return true;
  }
  return !shouldPollPR(row, eventEpoch);
}
/**
 * Observe one attached PR. Unforced (automatic) observations are throttled: they
 * reuse an observation accepted in the last 90 seconds and apply the background
 * terminal-PR policy, so a committed MERGED (or recently checked CLOSED) PR is
 * not fetched again. `force` is reserved for explicit refreshes and delivery
 * freshness checks, which must always read GitHub.
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
  const observation = await ports.fetchObservation(target, signal);
  signal?.throwIfAborted();
  const result = await ports.acceptObservation({
    target,
    expectedPrRevision: row.revision,
    expectedEventEpoch: config.eventEpoch,
    observation,
  });
  if (result.applied) {
    recent.set(key, {
      revision: row.revision + 1,
      epoch: config.eventEpoch,
      checkedAt: Date.now(),
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

import type { PRTarget } from '@/shared/pr-monitoring';
import type { PRObservationPorts } from './pr-observation-ports';
const states = new WeakMap<
  object,
  {
    recent: Map<string, { revision: number; epoch: number; checkedAt: number }>;
    observing: Map<string, Promise<boolean>>;
  }
>();
function observationState(ports: PRObservationPorts) {
  let state = states.get(ports.cacheScope);
  if (!state) {
    state = { recent: new Map(), observing: new Map() };
    states.set(ports.cacheScope, state);
  }
  return state;
}
export async function observeMonitoredPR(
  ports: PRObservationPorts,
  target: PRTarget,
  options?: { signal?: AbortSignal; force?: boolean }
): Promise<boolean> {
  const { signal } = options ?? {};
  const { recent, observing } = observationState(ports);
  const key = `${target.workspaceId}:${target.prId}`;
  const existing = observing.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const pending = (async () => {
    const [row, config] = await Promise.all([
      ports.findPR(target),
      ports.getMonitoring(target.workspaceId),
    ]);
    if (!(row && config)) {
      return false;
    }
    const cached = recent.get(key);
    if (
      !options?.force &&
      cached?.revision === row.revision &&
      cached.epoch === config.eventEpoch &&
      Date.now() - cached.checkedAt < 90_000
    ) {
      return true;
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
      });
    }
    return result.applied;
  })();
  observing.set(key, pending);
  try {
    return await pending;
  } finally {
    if (observing.get(key) === pending) {
      observing.delete(key);
    }
  }
}

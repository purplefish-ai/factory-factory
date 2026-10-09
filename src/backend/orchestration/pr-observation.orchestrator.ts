import { PR_SNAPSHOT_UPDATED } from '@/backend/services/github';
import type { PRTarget } from '@/shared/pr-monitoring';
import { defaultPRMonitoringServices } from './pr-monitoring-dependencies';
import type { PRObservationPorts } from './pr-monitoring-ports';
const states = new WeakMap<
  object,
  {
    recent: Map<string, { revision: number; epoch: number; checkedAt: number }>;
    observing: Map<string, Promise<boolean>>;
  }
>();
function observationState(services: PRObservationPorts) {
  let state = states.get(services.workspacePRMonitoringService);
  if (!state) {
    state = { recent: new Map(), observing: new Map() };
    states.set(services.workspacePRMonitoringService, state);
  }
  return state;
}
export async function observeMonitoredPR(
  target: PRTarget,
  signal?: AbortSignal,
  options?: { force?: boolean },
  services: PRObservationPorts = defaultPRMonitoringServices
): Promise<boolean> {
  const {
    workspacePrSnapshotService,
    workspacePRMonitoringService,
    prObservationService,
    prSnapshotService,
  } = services;
  const { recent, observing } = observationState(services);
  const key = `${target.workspaceId}:${target.prId}`;
  const existing = observing.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const pending = (async () => {
    const [row, config] = await Promise.all([
      workspacePrSnapshotService.find(target),
      workspacePRMonitoringService.get(target.workspaceId),
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
    const observation = await prObservationService.fetch(target, signal);
    signal?.throwIfAborted();
    const result = await workspacePrSnapshotService.acceptMonitoredObservation({
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
      prSnapshotService.emit(PR_SNAPSHOT_UPDATED, {
        workspaceId: target.workspaceId,
        prId: target.prId,
        prUrl: observation.url,
        prNumber: observation.number,
        prState: observation.prState,
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

import type { configService } from '@/backend/services/config.service';
import {
  PR_SNAPSHOT_UPDATED,
  type prObservationService,
  type prSnapshotService,
} from '@/backend/services/github';
import type {
  acpRuntimeManager,
  sessionDispatchService,
  findPRDeliveryReceipt,
  sessionBackgroundDeliveryService,
  sessionDataService,
  sessionDomainService,
  sessionLifecycleService,
} from '@/backend/services/session';
import type { userSettingsService } from '@/backend/services/settings';
import type {
  workspacePRMonitoringService,
  workspacePrSnapshotService,
} from '@/backend/services/workspace';
import type { PRObservationPorts } from './pr-observation-ports';
import type { RatchetService } from './ratchet.service';

export type PRMonitoringServices = {
  configService: typeof configService;
  prObservationService: typeof prObservationService;
  prSnapshotService: typeof prSnapshotService;
  ratchetService: RatchetService;
  acpRuntimeManager: typeof acpRuntimeManager;
  sessionDispatchService: Pick<typeof sessionDispatchService, 'tryDispatchNextMessage'>;
  findPRDeliveryReceipt: typeof findPRDeliveryReceipt;
  sessionBackgroundDeliveryService: typeof sessionBackgroundDeliveryService;
  sessionDataService: typeof sessionDataService;
  sessionDomainService: typeof sessionDomainService;
  sessionLifecycleService: typeof sessionLifecycleService;
  userSettingsService: typeof userSettingsService;
  workspacePRMonitoringService: typeof workspacePRMonitoringService;
  workspacePrSnapshotService: typeof workspacePrSnapshotService;
};
const observationCacheScopes = new WeakMap<object, object>();

// Composition passes one services object per application graph. A graph may
// create fresh wrappers for poll, manual refresh, and delivery; keying the scope
// by that object keeps their coalescing identity stable without exposing
// services to the producer.
export function createPRObservationPorts(
  services: Pick<
    PRMonitoringServices,
    | 'prObservationService'
    | 'prSnapshotService'
    | 'workspacePRMonitoringService'
    | 'workspacePrSnapshotService'
  >
): PRObservationPorts {
  let cacheScope = observationCacheScopes.get(services);
  if (!cacheScope) {
    cacheScope = {};
    observationCacheScopes.set(services, cacheScope);
  }
  return {
    cacheScope,
    findPR: (target) => services.workspacePrSnapshotService.find(target),
    getMonitoring: (workspaceId) => services.workspacePRMonitoringService.get(workspaceId),
    fetchObservation: (target, signal, options) =>
      services.prObservationService.fetch(target, signal, options),
    acceptObservation: (input) =>
      services.workspacePrSnapshotService.acceptMonitoredObservation(input),
    publishAcceptedObservation: (event) => {
      services.prSnapshotService.emit(PR_SNAPSHOT_UPDATED, event);
    },
  };
}

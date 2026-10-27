import { configService } from '@/backend/services/config.service';
import {
  PR_SNAPSHOT_UPDATED,
  prObservationService,
  prSnapshotService,
} from '@/backend/services/github';
import { ratchetService } from '@/backend/services/ratchet';
import {
  acpRuntimeManager,
  sessionDispatchService,
  findPRDeliveryReceipt,
  sessionBackgroundDeliveryService,
  sessionDataService,
  sessionDomainService,
  sessionLifecycleService,
} from '@/backend/services/session';
import { userSettingsService } from '@/backend/services/settings';
import {
  workspacePRMonitoringService,
  workspacePrSnapshotService,
} from '@/backend/services/workspace';
import type { PRObservationPorts } from './pr-observation-ports';

export type PRMonitoringServices = {
  configService: typeof configService;
  prObservationService: typeof prObservationService;
  prSnapshotService: typeof prSnapshotService;
  ratchetService: typeof ratchetService;
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
export const defaultPRMonitoringServices: PRMonitoringServices = {
  get configService() {
    return configService;
  },
  get prObservationService() {
    return prObservationService;
  },
  get prSnapshotService() {
    return prSnapshotService;
  },
  get ratchetService() {
    return ratchetService;
  },
  get acpRuntimeManager() {
    return acpRuntimeManager;
  },
  get sessionDispatchService() {
    return sessionDispatchService;
  },
  get findPRDeliveryReceipt() {
    return findPRDeliveryReceipt;
  },
  get sessionBackgroundDeliveryService() {
    return sessionBackgroundDeliveryService;
  },
  get sessionDataService() {
    return sessionDataService;
  },
  get sessionDomainService() {
    return sessionDomainService;
  },
  get sessionLifecycleService() {
    return sessionLifecycleService;
  },
  get userSettingsService() {
    return userSettingsService;
  },
  get workspacePRMonitoringService() {
    return workspacePRMonitoringService;
  },
  get workspacePrSnapshotService() {
    return workspacePrSnapshotService;
  },
};

const observationCacheScopes = new WeakMap<object, object>();

// A graph may create fresh wrappers for poll, manual refresh, and delivery.
// Keep their coalescing identity stable without exposing services to the producer.
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
    fetchObservation: (target, signal) => services.prObservationService.fetch(target, signal),
    acceptObservation: (input) =>
      services.workspacePrSnapshotService.acceptMonitoredObservation(input),
    publishAcceptedObservation: (event) => {
      services.prSnapshotService.emit(PR_SNAPSHOT_UPDATED, event);
    },
  };
}

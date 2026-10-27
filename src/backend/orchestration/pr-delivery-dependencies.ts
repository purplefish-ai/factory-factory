import {
  defaultPRMonitoringServices,
  createPRObservationPorts,
  type PRMonitoringServices,
} from './pr-monitoring-dependencies';
import type { PRDeliveryPorts } from './pr-monitoring-ports';
import { observeMonitoredPR } from './pr-observation.orchestrator';

// Composition is the only place delivery is connected to the observation producer.
export function createPRDeliveryPorts(services: PRMonitoringServices): PRDeliveryPorts {
  const observationPorts = createPRObservationPorts(services);
  return {
    refreshObservation: (target) => observeMonitoredPR(observationPorts, target, { force: true }),
    get configService() {
      return services.configService;
    },
    get ratchetService() {
      return services.ratchetService;
    },
    get acpRuntimeManager() {
      return services.acpRuntimeManager;
    },
    get sessionDispatchService() {
      return services.sessionDispatchService;
    },
    get findPRDeliveryReceipt() {
      return services.findPRDeliveryReceipt;
    },
    get sessionBackgroundDeliveryService() {
      return services.sessionBackgroundDeliveryService;
    },
    get sessionDataService() {
      return services.sessionDataService;
    },
    get sessionDomainService() {
      return services.sessionDomainService;
    },
    get sessionLifecycleService() {
      return services.sessionLifecycleService;
    },
    get userSettingsService() {
      return services.userSettingsService;
    },
    get workspacePRMonitoringService() {
      return services.workspacePRMonitoringService;
    },
    get workspacePrSnapshotService() {
      return services.workspacePrSnapshotService;
    },
  };
}

export const defaultPRDeliveryPorts = createPRDeliveryPorts(defaultPRMonitoringServices);

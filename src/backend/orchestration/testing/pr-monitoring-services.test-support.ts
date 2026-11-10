import type { PRMonitoringServices } from '@/backend/orchestration/pull-requests/pr-monitoring-dependencies';
import { createRatchetService } from '@/backend/orchestration/pull-requests/ratchet-dependencies';
import type { RatchetService } from '@/backend/orchestration/pull-requests/ratchet.service';
import { configService } from '@/backend/services/config.service';
import { prObservationService, prSnapshotService } from '@/backend/services/github';
import {
  acpRuntimeManager,
  findPRDeliveryReceipt,
  sessionBackgroundDeliveryService,
  sessionDataService,
  sessionDispatchService,
  sessionDomainService,
  sessionLifecycleService,
} from '@/backend/services/session';
import { userSettingsService } from '@/backend/services/settings';
import {
  workspacePRMonitoringService,
  workspacePrSnapshotService,
} from '@/backend/services/workspace';

/**
 * Builds one explicit PR-monitoring graph from the process service barrels
 * (or their `vi.mock` replacements). Getters read each barrel export on use, so
 * partial barrel mocks only need the capabilities a test exercises. Each call
 * is a new graph with its own observation cache scope; share the returned
 * object for one graph.
 */
export function createPRMonitoringTestServices(): PRMonitoringServices {
  let ratchetService: RatchetService | undefined;
  const services: PRMonitoringServices = {
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
      ratchetService ??= createRatchetService(() => services);
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
  return services;
}

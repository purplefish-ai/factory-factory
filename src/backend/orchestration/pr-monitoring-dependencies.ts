import { configService } from '@/backend/services/config.service';
import { prObservationService, prSnapshotService } from '@/backend/services/github';
import { ratchetService } from '@/backend/services/ratchet';
import {
  acpRuntimeManager,
  chatMessageHandlerService,
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

export type PRMonitoringServices = {
  configService: typeof configService;
  prObservationService: typeof prObservationService;
  prSnapshotService: typeof prSnapshotService;
  ratchetService: typeof ratchetService;
  acpRuntimeManager: typeof acpRuntimeManager;
  chatMessageHandlerService: typeof chatMessageHandlerService;
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
  get chatMessageHandlerService() {
    return chatMessageHandlerService;
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

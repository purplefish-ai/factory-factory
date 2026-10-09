import type { configService } from '@/backend/services/config.service';
import type { prObservationService, prSnapshotService } from '@/backend/services/github';
import type { ratchetService } from '@/backend/services/ratchet';
import type {
  acpRuntimeManager,
  chatMessageHandlerService,
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
import type { PRTarget } from '@/shared/pr-monitoring';

export interface PRObservationPorts {
  prObservationService: Pick<typeof prObservationService, 'fetch'>;
  prSnapshotService: Pick<typeof prSnapshotService, 'emit'>;
  workspacePRMonitoringService: Pick<typeof workspacePRMonitoringService, 'get'>;
  workspacePrSnapshotService: Pick<
    typeof workspacePrSnapshotService,
    'find' | 'acceptMonitoredObservation'
  >;
}

export interface PRRecipientReadinessPorts {
  sessionDataService: Pick<typeof sessionDataService, 'findAgentSessionsByWorkspaceId'>;
  acpRuntimeManager: Pick<typeof acpRuntimeManager, 'isSessionWorking'>;
}

export interface PRRecipientPorts {
  sessionDataService: Pick<typeof sessionDataService, 'findPRDedicatedSession'>;
}

export type PRDedicatedSessionPorts = PRRecipientReadinessPorts & {
  configService: Pick<typeof configService, 'getMaxSessionsPerWorkspace'>;
  sessionDataService: Pick<
    typeof sessionDataService,
    'findPRDedicatedSession' | 'acquirePRDedicatedSession'
  >;
  acpRuntimeManager: Pick<typeof acpRuntimeManager, 'getClient'>;
  sessionBackgroundDeliveryService: Pick<
    typeof sessionBackgroundDeliveryService,
    'captureResumeGuard'
  >;
  sessionLifecycleService: Pick<typeof sessionLifecycleService, 'startSession'>;
  workspacePRMonitoringService: Pick<
    typeof workspacePRMonitoringService,
    'get' | 'listPending' | 'pauseWorkspace'
  >;
};

export type PRDeliveryRecoveryPorts = PRRecipientPorts & {
  sessionDataService: Pick<typeof sessionDataService, 'findAgentSessionById'>;
  acpRuntimeManager: Pick<typeof acpRuntimeManager, 'isSessionWorking'>;
  sessionBackgroundDeliveryService: Pick<
    typeof sessionBackgroundDeliveryService,
    'isDeliveryActive'
  >;
  findPRDeliveryReceipt: typeof findPRDeliveryReceipt;
  workspacePRMonitoringService: Pick<
    typeof workspacePRMonitoringService,
    'get' | 'listPending' | 'pauseWorkspace' | 'cancelRecoveredDelivery' | 'recoverClaim'
  >;
};

export type PRDeliveryPorts = PRDedicatedSessionPorts &
  PRDeliveryRecoveryPorts & {
    // Freshness is a delivery prerequisite; the producer and its fetcher stay behind this port.
    refreshObservation: (target: PRTarget) => Promise<boolean>;
    sessionDomainService: Pick<typeof sessionDomainService, 'getPendingInteractiveRequest'>;
    chatMessageHandlerService: Pick<typeof chatMessageHandlerService, 'tryDispatchNextMessage'>;
    userSettingsService: Pick<typeof userSettingsService, 'get'>;
    workspacePrSnapshotService: Pick<typeof workspacePrSnapshotService, 'find'>;
    ratchetService: Pick<typeof ratchetService, 'emit'>;
    sessionBackgroundDeliveryService: Pick<
      typeof sessionBackgroundDeliveryService,
      'enqueue' | 'invalidate'
    >;
    workspacePRMonitoringService: Pick<
      typeof workspacePRMonitoringService,
      'claimDelivery' | 'settleDelivery' | 'deferBusy' | 'pause' | 'resume'
    >;
  };

import { createPRDeliveryPorts } from '@/backend/orchestration/pull-requests/pr-delivery-dependencies';
import { createPRBackgroundDeliveryPort } from '@/backend/orchestration/pull-requests/pr-event-delivery-port';
import { wakePRDelivery } from '@/backend/orchestration/pull-requests/pr-event-delivery.orchestrator';
import { retireLegacyRatchetSessions } from '@/backend/orchestration/pull-requests/pr-monitoring-cutover.orchestrator';
import {
  createPRObservationPorts,
  type PRMonitoringServices,
} from '@/backend/orchestration/pull-requests/pr-monitoring-dependencies';
import { setPRMonitoring } from '@/backend/orchestration/pull-requests/pr-monitoring.orchestrator';
import { observeMonitoredPR } from '@/backend/orchestration/pull-requests/pr-observation.orchestrator';
import { listVisibleReviewRequests } from '@/backend/orchestration/pull-requests/review-requests.orchestrator';
import type { reconciliationService } from '@/backend/orchestration/workspace-lifecycle/reconciliation.service';
import { captureWorkspaceRunResults } from '@/backend/orchestration/workspace-lifecycle/workspace-deletion.orchestrator';
import type {
  initializeWorkspaceWorktree,
  recoverStaleProvisioningWorkspace,
} from '@/backend/orchestration/workspace-lifecycle/workspace-init.orchestrator';
import type {
  PeriodicTaskLaunchSource,
  WorkspaceLauncher,
} from '@/backend/orchestration/workspace-lifecycle/workspace-launch.orchestrator';
/**
 * Domain Bridge Wiring
 *
 * Configures the cross-domain bridges of one application graph from the
 * services object supplied by the composition root (`app-context.ts`). Must run
 * before those domain services are used. Domain services never import each
 * other; they receive capabilities via these bridges.
 */
import type {
  githubCLIService,
  prFetchCoordinator,
  prSnapshotService,
} from '@/backend/services/github';
import type { createLogger } from '@/backend/services/logger.service';
import type { periodicTaskService } from '@/backend/services/periodic-task';
import type { ratchetService } from '@/backend/services/ratchet';
import type { startupScriptService } from '@/backend/services/run-script';
import type {
  acpRuntimeManager,
  chatEventForwarderService,
  sessionDispatchService,
  sessionDataService,
  sessionDomainService,
  sessionLifecycleEventService,
  sessionLifecycleService,
  sessionPromptTurnCompletionService,
  sessionService,
} from '@/backend/services/session';
import type { terminalSessionService } from '@/backend/services/terminal';
import {
  deriveWorkspaceFlowState,
  type getWorkspaceInitPolicy,
  type WorkspaceInitPolicyInput,
  type workspaceActivityService,
  type workspaceDataService,
  type workspaceMaintenanceService,
  type workspacePrSnapshotService,
  type workspaceQueryService,
  type workspaceRunScriptService,
  type workspaceSnapshotStore,
  type workspaceStateMachine,
} from '@/backend/services/workspace';
import { deriveWorkspaceSidebarStatus } from '@/shared/core';
import { dispatchBackgroundAction } from './background-action-dispatch.orchestrator';
export type BridgeServices = PRMonitoringServices & {
  workspaceMetadata?: {
    schedule(sessionId: string, initialOnly?: boolean): Promise<void>;
    start(): void;
    stop(): Promise<void>;
  };
  chatEventForwarderService: typeof chatEventForwarderService;
  sessionDispatchService: Pick<
    typeof sessionDispatchService,
    'configure' | 'tryDispatchNextMessage'
  >;
  createLogger: typeof createLogger;
  getWorkspaceInitPolicy: typeof getWorkspaceInitPolicy;
  githubCLIService: typeof githubCLIService;
  initializeWorkspaceWorktree: typeof initializeWorkspaceWorktree;
  periodicTaskService: typeof periodicTaskService;
  prFetchCoordinator: typeof prFetchCoordinator;
  prSnapshotService: typeof prSnapshotService;
  ratchetService: typeof ratchetService;
  recoverStaleProvisioningWorkspace: typeof recoverStaleProvisioningWorkspace;
  reconciliationService: typeof reconciliationService;
  acpRuntimeManager: typeof acpRuntimeManager;
  sessionDataService: typeof sessionDataService;
  sessionDomainService: typeof sessionDomainService;
  sessionLifecycleEventService: Pick<
    typeof sessionLifecycleEventService,
    'findLatestSessionFailure'
  >;
  sessionLifecycleService: typeof sessionLifecycleService;
  sessionPromptTurnCompletionService: typeof sessionPromptTurnCompletionService;
  sessionService: typeof sessionService;
  startupScriptService: typeof startupScriptService;
  terminalSessionService: typeof terminalSessionService;
  workspaceActivityService: typeof workspaceActivityService;
  launchWorkspace: WorkspaceLauncher<PeriodicTaskLaunchSource>;
  workspaceDataService: typeof workspaceDataService;
  workspaceMaintenanceService: typeof workspaceMaintenanceService;
  workspacePrSnapshotService: typeof workspacePrSnapshotService;
  workspaceQueryService: typeof workspaceQueryService;
  workspaceRunScriptService: typeof workspaceRunScriptService;
  workspaceSnapshotStore: typeof workspaceSnapshotStore;
  workspaceStateMachine: typeof workspaceStateMachine;
};

export function configureDomainBridges(services: BridgeServices): void {
  const {
    acpRuntimeManager,
    chatEventForwarderService,
    sessionDispatchService,
    createLogger,
    getWorkspaceInitPolicy,
    githubCLIService,
    initializeWorkspaceWorktree,
    periodicTaskService,
    prSnapshotService,
    ratchetService,
    recoverStaleProvisioningWorkspace,
    reconciliationService,
    sessionDataService,
    sessionDomainService,
    sessionLifecycleEventService,
    sessionLifecycleService,
    sessionPromptTurnCompletionService,
    sessionService,
    startupScriptService,
    terminalSessionService,
    workspaceActivityService,
    launchWorkspace,
    workspaceDataService,
    workspaceMaintenanceService,
    workspacePrSnapshotService,
    workspaceQueryService,
    workspaceRunScriptService,
    workspaceSnapshotStore,
    workspaceStateMachine,
  } = services;
  const logger = createLogger('domain-bridges');
  workspaceDataService.configureDeletionCapture(captureWorkspaceRunResults);

  const { prObservationService, sessionBackgroundDeliveryService, userSettingsService } = services;
  const observationPorts = createPRObservationPorts(services);
  const deliveryPorts = createPRDeliveryPorts(services, logger);
  // === Ratchet domain bridges ===
  ratchetService.configure({
    retireLegacy: () => retireLegacyRatchetSessions(services),
    observe: (target, signal) => observeMonitoredPR(observationPorts, target, { signal }),
    wake: (workspaceId, isCurrent) => wakePRDelivery(workspaceId, deliveryPorts, isCurrent),
    setMonitoring: (input) => setPRMonitoring(input, services),
  });
  sessionBackgroundDeliveryService.configure(createPRBackgroundDeliveryPort(deliveryPorts));
  prObservationService.configure({
    findPR: (target) => workspacePrSnapshotService.find(target),
    readPolicy: async () => ({
      reviewTriggerMode: (await userSettingsService.get()).ratchetReviewTriggerMode,
    }),
  });
  reconciliationService.configure({
    workspace: {
      initializeWorktree: (id, options) => initializeWorkspaceWorktree(id, options),
      findNeedingWorktree: () => workspaceMaintenanceService.findNeedingWorktree(),
      recoverStaleProvisioningWorkspace: (id, reason) =>
        recoverStaleProvisioningWorkspace(id, reason),
    },
    terminal: {
      recoverOrphanedSessions: () => terminalSessionService.recoverOrphanedSessions(),
    },
  });

  // === Workspace domain bridges ===
  workspaceQueryService.configure({
    session: {
      getAllPendingRequests: () => chatEventForwarderService.getAllPendingRequests(),
      getRuntimeSnapshot: (id) => sessionLifecycleService.getRuntimeSnapshot(id),
    },
    github: {
      checkHealth: () => githubCLIService.checkHealth(),
      listReviewRequests: () => listVisibleReviewRequests(services),
    },
    prSnapshot: {
      refreshWorkspace: (id, options) => prSnapshotService.refreshWorkspace(id, options),
    },
  });

  // === GitHub domain bridges ===
  prSnapshotService.configure({
    observe: (target, options) => observeMonitoredPR(observationPorts, target, options),
    workspace: {
      listPRs: (id) => workspacePrSnapshotService.list(id),
      findPR: (target) => workspacePrSnapshotService.find(target),
      attachPR: (id, url) => workspacePrSnapshotService.attach(id, url),
      detachPR: (target) => workspacePrSnapshotService.detach(target),
      attachDiscoveredPRsIfClaimMatches: (id, claim, urls) =>
        workspacePrSnapshotService.attachDiscoveredPRsIfClaimMatches(id, claim, urls),
      findPRContext: (id) => workspaceDataService.findPRContext(id),
    },
  });

  // === Session domain bridges ===
  const markSessionIdle = (workspaceId: string, sessionId: string, generation?: number) => {
    workspaceActivityService.markSessionIdle(workspaceId, sessionId, generation);
    void wakePRDelivery(workspaceId, deliveryPorts).catch((error) => {
      logger.warn('PR delivery wake deferred after session became idle', { workspaceId, error });
    });
  };
  chatEventForwarderService.configure({
    workspace: {
      markSessionRunning: (wsId, sId) => workspaceActivityService.markSessionRunning(wsId, sId),
      markSessionIdle,
      on: (event, handler) => workspaceActivityService.on(event, handler),
    },
  });

  const sessionWorkspaceBridge = {
    markSessionRunning: (wsId: string, sId: string) =>
      workspaceActivityService.markSessionRunning(wsId, sId),
    markSessionIdle,
    resetPRDiscoveryBackoff: (workspaceId: string) =>
      workspaceDataService.resetPRDiscoveryBackoff(workspaceId),
  };

  sessionService.configure({
    workspace: sessionWorkspaceBridge,
  });

  sessionLifecycleService.configure({
    workspace: sessionWorkspaceBridge,
    messageQueue: {
      tryDispatchNextMessage: (sessionId, options) =>
        sessionDispatchService.tryDispatchNextMessage(sessionId, ...(options ? [options] : [])),
    },
  });

  sessionDispatchService.configure({
    initPolicy: {
      getWorkspaceInitPolicy: (input) => getWorkspaceInitPolicy(input as WorkspaceInitPolicyInput),
    },
  });
  sessionPromptTurnCompletionService.setHandler((sessionId) => {
    void services.workspaceMetadata?.schedule(sessionId);
    return sessionDispatchService.tryDispatchNextMessage(sessionId, {
      bypassTurnInProgressBackoff: true,
    });
  });

  // === Run-script domain bridges ===
  startupScriptService.configure({
    workspace: {
      markReady: (id) => workspaceStateMachine.markReady(id),
      markFailed: (id, msg) => workspaceStateMachine.markFailed(id, msg),
      clearInitOutput: (id, guard) => workspaceRunScriptService.clearInitOutput(id, guard),
      appendInitOutput: (id, output, maxSize, guard) =>
        workspaceRunScriptService.appendInitOutput(id, output, maxSize, guard),
      setInitScriptPid: (id, pid, guard) =>
        workspaceRunScriptService.setInitScriptPid(id, pid, guard),
      clearInitScriptPid: (id, pid, guard) =>
        workspaceRunScriptService.clearInitScriptPid(id, pid, guard),
    },
  });

  // === Periodic task domain bridges ===
  periodicTaskService.configure({
    timerDispatch: {
      async dispatchTimerEvent(event) {
        const { workspaceId } = await dispatchBackgroundAction(
          { target: 'new_workspace', event },
          { launchWorkspace }
        );
        return { workspaceId };
      },
    },
    status: {
      async getWorkspaceStatus(workspaceId) {
        const ws = await workspaceDataService.findStatusSnapshot(workspaceId);
        if (!ws) {
          return null;
        }
        const [sessions, sessionFailure] = await Promise.all([
          sessionDataService.findAgentSessionsByWorkspaceId(workspaceId),
          sessionLifecycleEventService.findLatestSessionFailure(workspaceId),
        ]);
        const sessionIds = sessions.map((session) => session.id);
        return {
          status: ws.status,
          prUrl: ws.prUrl,
          prNumber: ws.prNumber,
          isAgentWorking:
            acpRuntimeManager.isAnySessionWorking(sessionIds) ||
            sessionIds.some(
              (sessionId) =>
                acpRuntimeManager.isSessionRunning(sessionId) &&
                sessionDomainService.getQueueLength(sessionId) > 0
            ),
          initCompletedAt: ws.initCompletedAt,
          sessionFailureMessage: sessionFailure?.message ?? null,
          // Every successful provider start persists its session ID before prompting.
          hasLaunchedSession: sessions.some((session) => Boolean(session.providerSessionId)),
        };
      },
    },
  });

  // === Snapshot store derivation functions ===
  workspaceSnapshotStore.configure({
    deriveFlowState: (input) =>
      deriveWorkspaceFlowState({
        ...input,
        prUpdatedAt: input.prUpdatedAt ? new Date(input.prUpdatedAt) : null,
      }),
    deriveSidebarStatus: (input) => deriveWorkspaceSidebarStatus(input),
  });
}

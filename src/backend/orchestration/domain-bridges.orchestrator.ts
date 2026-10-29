import type {
  githubCLIService,
  prFetchCoordinator,
  prSnapshotService,
} from '@/backend/services/github';
import type { createLogger } from '@/backend/services/logger.service';
import type { periodicTaskService } from '@/backend/services/periodic-task';
import type { ratchetService } from '@/backend/services/ratchet';
/**
 * Domain Bridge Wiring
 *
 * Single entry point that configures all cross-domain bridges at application startup.
 * Must be called BEFORE any domain service is used.
 *
 * Import graph: orchestration -> all 6 domain barrels
 * Domain services never import each other; they receive capabilities via bridges.
 */
import type { startupScriptService } from '@/backend/services/run-script';
import type {
  acpRuntimeManager,
  chatEventForwarderService,
  sessionDispatchService,
  sessionDataService,
  sessionDomainService,
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
import { deriveWorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';
import { createPRDeliveryPorts } from './pr-delivery-dependencies';
import { createPRBackgroundDeliveryPort } from './pr-event-delivery-port';
import { wakePRDelivery } from './pr-event-delivery.orchestrator';
import { retireLegacyRatchetSessions } from './pr-monitoring-cutover.orchestrator';
import { createPRObservationPorts, type PRMonitoringServices } from './pr-monitoring-dependencies';
import { setPRMonitoring } from './pr-monitoring.orchestrator';
import { observeMonitoredPR } from './pr-observation.orchestrator';
import type { reconciliationService } from './reconciliation.service';
import { listVisibleReviewRequests } from './review-requests.orchestrator';
import type {
  initializeWorkspaceWorktree,
  recoverStaleProvisioningWorkspace,
} from './workspace-init.orchestrator';
import type { PeriodicTaskLaunchSource, WorkspaceLauncher } from './workspace-launch.orchestrator';
export type BridgeServices = PRMonitoringServices & {
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

  const { prObservationService, sessionBackgroundDeliveryService, userSettingsService } = services;
  const observationPorts = createPRObservationPorts(services);
  const deliveryPorts = createPRDeliveryPorts(services);
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
      refreshWorkspace: (id, url) => prSnapshotService.refreshWorkspace(id, url),
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
    recordRatchetSessionEnd: (
      _workspaceId: string,
      _sessionId: string,
      _outcome: 'COMPLETED' | 'DIED'
    ) => Promise.resolve(),
    resetPRDiscoveryBackoff: (workspaceId: string) =>
      workspaceDataService.resetPRDiscoveryBackoff(workspaceId),
  };

  sessionService.configure({
    workspace: sessionWorkspaceBridge,
  });

  sessionLifecycleService.configure({
    workspace: sessionWorkspaceBridge,
    messageQueue: {
      tryDispatchNextMessage: (sessionId) =>
        sessionDispatchService.tryDispatchNextMessage(sessionId),
    },
  });

  sessionDispatchService.configure({
    initPolicy: {
      getWorkspaceInitPolicy: (input) => getWorkspaceInitPolicy(input as WorkspaceInitPolicyInput),
    },
  });
  sessionPromptTurnCompletionService.setHandler((sessionId) =>
    sessionDispatchService.tryDispatchNextMessage(sessionId, {
      bypassTurnInProgressBackoff: true,
    })
  );

  // === Run-script domain bridges ===
  startupScriptService.configure({
    workspace: {
      markReady: (id) => workspaceStateMachine.markReady(id),
      markFailed: (id, msg) => workspaceStateMachine.markFailed(id, msg),
      clearInitOutput: (id) => workspaceRunScriptService.clearInitOutput(id),
      appendInitOutput: (id, output, maxSize) =>
        workspaceRunScriptService.appendInitOutput(id, output, maxSize),
      setInitScriptPid: (id, pid) => workspaceRunScriptService.setInitScriptPid(id, pid),
      clearInitScriptPid: (id, pid) => workspaceRunScriptService.clearInitScriptPid(id, pid),
    },
  });

  // === Periodic task domain bridges ===
  periodicTaskService.configure({
    workspace: {
      async createWorkspaceForTask({ projectId, name, prompt, periodicTaskId }) {
        const { workspace } = await launchWorkspace({
          type: 'PERIODIC_TASK',
          projectId,
          name,
          periodicTaskId,
          initialPrompt: prompt,
          ratchetEnabled: true,
        });

        return { workspaceId: workspace.id };
      },
    },
    status: {
      async getWorkspaceStatus(workspaceId) {
        const ws = await workspaceDataService.findStatusSnapshot(workspaceId);
        if (!ws) {
          return null;
        }
        const sessions = await sessionDataService.findAgentSessionsByWorkspaceId(workspaceId);
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

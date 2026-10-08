import { toError } from '@/backend/lib/error-utils';
import type {
  AutoIterationLogbookBridge,
  AutoIterationSessionBridge,
  AutoIterationWorkspaceBridge,
  autoIterationService,
  logbookService,
} from '@/backend/services/auto-iteration';
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
  chatMessageHandlerService,
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
  type WorkspaceCreationService,
  type WorkspaceInitPolicyInput,
  type workspaceActivityService,
  type workspaceAutoIterationService,
  type workspaceDataService,
  type workspaceMaintenanceService,
  type workspacePrSnapshotService,
  type workspaceQueryService,
  type workspaceRunScriptService,
  type workspaceSnapshotStore,
  type workspaceStateMachine,
} from '@/backend/services/workspace';
import { AutoIterationStatus, SessionStatus } from '@/shared/core';
import { deriveWorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';
import { createPRBackgroundDeliveryPort } from './pr-event-delivery-port';
import { wakePRDelivery } from './pr-event-delivery.orchestrator';
import { retireLegacyRatchetSessions } from './pr-monitoring-cutover.orchestrator';
import { setPRMonitoring } from './pr-monitoring.orchestrator';
import { observeMonitoredPR } from './pr-observation.orchestrator';
import type { reconciliationService } from './reconciliation.service';
import type {
  initializeWorkspaceWorktree,
  recoverStaleProvisioningWorkspace,
} from './workspace-init.orchestrator';

type SessionDataService = typeof sessionDataService;
type SessionDomainService = typeof sessionDomainService;
type SessionLifecycleService = typeof sessionLifecycleService;
type WorkspaceAutoIterationService = typeof workspaceAutoIterationService;
type AutoIterationRollbackReason =
  | 'auto_iteration_startup_failed_after_create'
  | 'auto_iteration_recycle_failed_after_create';

import type { PRMonitoringServices } from './pr-monitoring-dependencies';
export type BridgeServices = PRMonitoringServices & {
  autoIterationService: typeof autoIterationService;
  chatEventForwarderService: typeof chatEventForwarderService;
  chatMessageHandlerService: typeof chatMessageHandlerService;
  createLogger: typeof createLogger;
  getWorkspaceInitPolicy: typeof getWorkspaceInitPolicy;
  githubCLIService: typeof githubCLIService;
  initializeWorkspaceWorktree: typeof initializeWorkspaceWorktree;
  logbookService: typeof logbookService;
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
  workspaceAutoIterationService: typeof workspaceAutoIterationService;
  workspaceCreationService: WorkspaceCreationService;
  workspaceDataService: typeof workspaceDataService;
  workspaceMaintenanceService: typeof workspaceMaintenanceService;
  workspacePrSnapshotService: typeof workspacePrSnapshotService;
  workspaceQueryService: typeof workspaceQueryService;
  workspaceRunScriptService: typeof workspaceRunScriptService;
  workspaceSnapshotStore: typeof workspaceSnapshotStore;
  workspaceStateMachine: typeof workspaceStateMachine;
};

async function stopSessionBestEffort(
  sessionLifecycleService: SessionLifecycleService,
  sessionId: string
): Promise<void> {
  try {
    await sessionLifecycleService.stopSession(sessionId, { recordLifecycleEvent: false });
  } catch {
    // Best-effort cleanup
  }
}

async function stopPreviousAutoIterationSession(
  sessionLifecycleService: SessionLifecycleService,
  sessionId: string
): Promise<void> {
  try {
    await sessionLifecycleService.stopSession(sessionId);
  } catch (error) {
    if (!(error instanceof Error && /already stopped|not found/i.test(error.message))) {
      throw error;
    }
    // Session may already be stopped
  }
}

async function finishFailedAutoIterationSessionIfMatching(
  workspaceAutoIterationService: WorkspaceAutoIterationService,
  workspaceId: string,
  sessionId: string
): Promise<boolean> {
  try {
    return await workspaceAutoIterationService.finishSessionIfMatching(
      workspaceId,
      sessionId,
      AutoIterationStatus.FAILED
    );
  } catch {
    // Preserve the original handoff or persistence error
    return false;
  }
}

async function rollbackCreatedAutoIterationSession(
  sessionLifecycleService: SessionLifecycleService,
  sessionDataService: SessionDataService,
  sessionDomainService: SessionDomainService,
  sessionId: string,
  rollbackReason: AutoIterationRollbackReason
): Promise<void> {
  await stopSessionBestEffort(sessionLifecycleService, sessionId);

  try {
    sessionDomainService.clearSession(sessionId);
  } catch {
    // Preserve the original startup or handoff error
  }

  try {
    await sessionDataService.deleteAgentSession(sessionId);
  } catch {
    try {
      await sessionDataService.updateAgentSession(sessionId, {
        status: SessionStatus.FAILED,
        providerProcessPid: null,
        providerMetadata: {
          rollbackReason,
        },
      });
    } catch {
      // Preserve the original startup or handoff error
    }
  }
}

async function retireStoppedAutoIterationSession(
  sessionDataService: SessionDataService,
  sessionId: string
): Promise<void> {
  await sessionDataService.updateAgentSession(sessionId, {
    status: SessionStatus.COMPLETED,
    providerProcessPid: null,
  });
}

async function retireStoppedAutoIterationSessionBestEffort(
  sessionDataService: SessionDataService,
  sessionId: string
): Promise<void> {
  try {
    await retireStoppedAutoIterationSession(sessionDataService, sessionId);
  } catch {
    // Retirement bookkeeping must not invalidate a failed cleanup or successful handoff
  }
}

async function finishFailedRecycleIfSessionMatches(
  workspaceAutoIterationService: WorkspaceAutoIterationService,
  workspaceId: string,
  previousSessionId: string | undefined,
  replacementSessionId: string | undefined
): Promise<void> {
  if (
    replacementSessionId &&
    (await finishFailedAutoIterationSessionIfMatching(
      workspaceAutoIterationService,
      workspaceId,
      replacementSessionId
    ))
  ) {
    return;
  }
  if (previousSessionId && previousSessionId !== replacementSessionId) {
    await finishFailedAutoIterationSessionIfMatching(
      workspaceAutoIterationService,
      workspaceId,
      previousSessionId
    );
  }
}

async function cleanupFailedAutoIterationRecycle(
  sessionLifecycleService: SessionLifecycleService,
  sessionDataService: SessionDataService,
  sessionDomainService: SessionDomainService,
  workspaceAutoIterationService: WorkspaceAutoIterationService,
  workspaceId: string,
  previousSessionId: string | undefined,
  replacementSessionId?: string
): Promise<void> {
  await finishFailedRecycleIfSessionMatches(
    workspaceAutoIterationService,
    workspaceId,
    previousSessionId,
    replacementSessionId
  );
  if (replacementSessionId) {
    await rollbackCreatedAutoIterationSession(
      sessionLifecycleService,
      sessionDataService,
      sessionDomainService,
      replacementSessionId,
      'auto_iteration_recycle_failed_after_create'
    );
  }
  if (previousSessionId) {
    await retireStoppedAutoIterationSessionBestEffort(sessionDataService, previousSessionId);
  }
}

export function configureDomainBridges(services: BridgeServices): void {
  const {
    acpRuntimeManager,
    autoIterationService,
    chatEventForwarderService,
    chatMessageHandlerService,
    createLogger,
    getWorkspaceInitPolicy,
    githubCLIService,
    initializeWorkspaceWorktree,
    logbookService,
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
    workspaceAutoIterationService,
    workspaceCreationService,
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
  // === Ratchet domain bridges ===
  ratchetService.configure({
    retireLegacy: () => retireLegacyRatchetSessions(services),
    observe: (target, signal) => observeMonitoredPR(target, signal, undefined, services),
    wake: (workspaceId) => wakePRDelivery(workspaceId, services),
    setMonitoring: (input) => setPRMonitoring(input, services),
  });
  sessionBackgroundDeliveryService.configure(createPRBackgroundDeliveryPort(services));
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
      listReviewRequests: () => githubCLIService.listReviewRequests(),
    },
    prSnapshot: {
      refreshWorkspace: (id, url) => prSnapshotService.refreshWorkspace(id, url),
    },
  });

  // === GitHub domain bridges ===
  prSnapshotService.configure({
    observe: (target, options) => observeMonitoredPR(target, undefined, options, services),
    workspace: {
      listPRs: (id) => workspacePrSnapshotService.list(id),
      findPR: (target) => workspacePrSnapshotService.find(target),
      attachPR: (id, url) => workspacePrSnapshotService.attach(id, url),
      detachPR: (target) => workspacePrSnapshotService.detach(target),
      attachDiscoveredPRsIfClaimMatches: (id, claim, urls) =>
        workspacePrSnapshotService.attachDiscoveredPRsIfClaimMatches(id, claim, urls),
      findPRContext: (id) => workspaceDataService.findPRContext(id),
      recordSnapshot: (id, data) => workspacePrSnapshotService.record(id, data),
      applyPrSnapshotWithDispatchReset: (id, observation) =>
        workspacePrSnapshotService.applyPrSnapshotWithDispatchReset(id, observation),
      applyPrObservationWithDispatchReset: (id, observation) =>
        workspacePrSnapshotService.applyPrObservationWithDispatchReset(id, observation),
      attachDiscoveredPRIfClaimMatches: (id, url, claim, updatedAt) =>
        workspacePrSnapshotService.attachDiscoveredPRIfClaimMatches(id, url, claim, updatedAt),
      updatePRSnapshotIfUrlMatches: (id, url, snapshot, updatedAt) =>
        workspacePrSnapshotService.updatePRSnapshotIfUrlMatches(id, url, snapshot, updatedAt),
    },
  });

  // === Session domain bridges ===
  chatEventForwarderService.configure({
    workspace: {
      markSessionRunning: (wsId, sId) => workspaceActivityService.markSessionRunning(wsId, sId),
      markSessionIdle: (wsId, sId, generation) =>
        workspaceActivityService.markSessionIdle(wsId, sId, generation),
      on: (event, handler) => workspaceActivityService.on(event, handler),
    },
  });

  const sessionWorkspaceBridge = {
    markSessionRunning: (wsId: string, sId: string) =>
      workspaceActivityService.markSessionRunning(wsId, sId),
    markSessionIdle: (wsId: string, sId: string, generation?: number) =>
      workspaceActivityService.markSessionIdle(wsId, sId, generation),
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
        chatMessageHandlerService.tryDispatchNextMessage(sessionId),
    },
    autoIterationExit: {
      onAutoIterationSessionExit: (workspaceId, sessionId) =>
        autoIterationService.onSessionDeath(workspaceId, sessionId),
    },
  });

  chatMessageHandlerService.configure({
    initPolicy: {
      getWorkspaceInitPolicy: (input) => getWorkspaceInitPolicy(input as WorkspaceInitPolicyInput),
    },
  });
  sessionPromptTurnCompletionService.setHandler((sessionId) =>
    chatMessageHandlerService.tryDispatchNextMessage(sessionId, {
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

  // === Auto-iteration domain bridges ===
  const autoIterationWorkspaceBridge: AutoIterationWorkspaceBridge = {
    async getWorktreePath(workspaceId) {
      const ws = await workspaceAutoIterationService.getExecutionContext(workspaceId);
      if (!ws?.worktreePath) {
        throw new Error(`Workspace ${workspaceId} has no worktree path`);
      }
      return ws.worktreePath;
    },
    async updateAutoIterationStatus(workspaceId, status) {
      await workspaceAutoIterationService.setStatus(workspaceId, status);
    },
    async updateAutoIterationProgress(workspaceId, progress) {
      await workspaceAutoIterationService.setProgress(workspaceId, progress);
    },
    async updateAutoIterationSessionId(workspaceId, sessionId) {
      await workspaceAutoIterationService.setSession(workspaceId, sessionId);
    },
    finishAutoIterationIfSessionMatches(workspaceId, sessionId, status) {
      return workspaceAutoIterationService.finishSessionIfMatching(workspaceId, sessionId, status);
    },
  };

  const autoIterationSessionBridge: AutoIterationSessionBridge = {
    async startSession(workspaceId, opts) {
      const session = await sessionDataService.createAgentSession({
        workspaceId,
        name: 'Auto-iteration',
        workflow: 'auto-iteration',
      });
      try {
        await sessionLifecycleService.startSession(session.id, {
          initialPrompt: opts.initialPrompt,
          startupModePreset: opts.startupModePreset,
        });
      } catch (err) {
        await rollbackCreatedAutoIterationSession(
          sessionLifecycleService,
          sessionDataService,
          sessionDomainService,
          session.id,
          'auto_iteration_startup_failed_after_create'
        );
        throw err;
      }
      return session.id;
    },
    async sendPrompt(sessionId, prompt, timeoutMs) {
      await sessionService.sendAcpMessage(sessionId, [{ type: 'text', text: prompt }], timeoutMs, {
        timeoutKind: 'configured',
      });
    },
    async waitForIdle(_sessionId) {
      // sendAcpMessage already blocks until the turn completes
    },
    async stopSession(sessionId) {
      await sessionLifecycleService.stopSession(sessionId);
    },
    getLastAssistantMessage(sessionId): Promise<string> {
      const transcript = sessionDomainService.getTranscriptSnapshot(sessionId);
      for (let i = transcript.length - 1; i >= 0; i--) {
        const entry = transcript[i];
        // AgentMessage.type === 'assistant' identifies assistant turns
        // AgentMessage.message.content is AgentContentItem[] | string
        if (entry?.message?.type === 'assistant') {
          const content = entry.message.message?.content;
          if (typeof content === 'string') {
            return Promise.resolve(content);
          }
          if (Array.isArray(content)) {
            return Promise.resolve(
              content
                .filter(
                  (b) => typeof b === 'object' && b !== null && 'type' in b && b.type === 'text'
                )
                .map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
                .join('')
            );
          }
          return Promise.resolve('');
        }
      }
      return Promise.resolve('');
    },
    async recycleSession(workspaceId, handoffPrompt) {
      const ws = await workspaceAutoIterationService.getExecutionContext(workspaceId);
      const previousSessionId = ws?.autoIterationSessionId ?? undefined;
      if (previousSessionId) {
        await stopPreviousAutoIterationSession(sessionLifecycleService, previousSessionId);
      }
      let newSession: Awaited<ReturnType<SessionDataService['createAgentSession']>>;
      try {
        newSession = await sessionDataService.createAgentSession({
          workspaceId,
          name: 'Auto-iteration (recycled)',
          workflow: 'auto-iteration',
        });
      } catch (err) {
        await cleanupFailedAutoIterationRecycle(
          sessionLifecycleService,
          sessionDataService,
          sessionDomainService,
          workspaceAutoIterationService,
          workspaceId,
          previousSessionId
        );
        throw err;
      }
      try {
        await sessionLifecycleService.startSession(newSession.id, {
          startupModePreset: 'non_interactive',
        });
      } catch (err) {
        await cleanupFailedAutoIterationRecycle(
          sessionLifecycleService,
          sessionDataService,
          sessionDomainService,
          workspaceAutoIterationService,
          workspaceId,
          previousSessionId,
          newSession.id
        );
        throw err;
      }
      try {
        await workspaceAutoIterationService.setSession(workspaceId, newSession.id);
        await sessionService.sendAcpMessage(newSession.id, [{ type: 'text', text: handoffPrompt }]);
        if (previousSessionId) {
          await retireStoppedAutoIterationSessionBestEffort(sessionDataService, previousSessionId);
        }
      } catch (err) {
        await cleanupFailedAutoIterationRecycle(
          sessionLifecycleService,
          sessionDataService,
          sessionDomainService,
          workspaceAutoIterationService,
          workspaceId,
          previousSessionId,
          newSession.id
        );
        throw err;
      }
      return newSession.id;
    },
  };

  const autoIterationLogbookBridge: AutoIterationLogbookBridge = logbookService;

  autoIterationService.configure(
    autoIterationSessionBridge,
    autoIterationWorkspaceBridge,
    autoIterationLogbookBridge
  );

  // === Periodic task domain bridges ===
  periodicTaskService.configure({
    workspace: {
      async createWorkspaceForTask({ projectId, name, prompt, periodicTaskId }) {
        const workspace = await workspaceCreationService.create({
          type: 'PERIODIC_TASK',
          projectId,
          name,
          periodicTaskId,
          initialPrompt: prompt,
          ratchetEnabled: true,
        });

        // Create default session
        await sessionDataService.createAgentSession({
          workspaceId: workspace.id,
          workflow: 'implement',
          name: 'Periodic task',
        });

        // Initialize worktree in background
        void initializeWorkspaceWorktree(workspace.id).catch((error) => {
          logger.error('Failed to initialize workspace for periodic task', toError(error), {
            workspaceId: workspace.id,
          });
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

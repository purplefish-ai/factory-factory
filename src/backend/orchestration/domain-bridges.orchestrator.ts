/**
 * Domain Bridge Wiring
 *
 * Single entry point that configures all cross-domain bridges at application startup.
 * Must be called BEFORE any domain service is used.
 *
 * Import graph: orchestration -> all 6 domain barrels
 * Domain services never import each other; they receive capabilities via bridges.
 */

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
  prFetchRegistry,
  prSnapshotService,
} from '@/backend/services/github';
import type { createLogger } from '@/backend/services/logger.service';
import type { periodicTaskService } from '@/backend/services/periodic-task';
import type {
  fixerSessionService,
  RatchetGitHubBridge,
  RatchetPRSnapshotBridge,
  RatchetSessionBridge,
  ratchetService,
} from '@/backend/services/ratchet';
import type { startupScriptService } from '@/backend/services/run-script';
import type {
  chatEventForwarderService,
  chatMessageHandlerService,
  sessionDataService,
  sessionDomainService,
  sessionService,
} from '@/backend/services/session';
import type { terminalSessionService } from '@/backend/services/terminal';
import {
  computeKanbanColumn,
  deriveWorkspaceFlowState,
  type getWorkspaceInitPolicy,
  type kanbanStateService,
  type WorkspaceCreationService,
  type WorkspaceInitPolicyInput,
  type workspaceActivityService,
  type workspaceAutoIterationService,
  type workspaceDataService,
  type workspaceMaintenanceService,
  type workspacePrSnapshotService,
  type workspaceQueryService,
  type workspaceRatchetService,
  type workspaceRunScriptService,
  type workspaceSnapshotStore,
  type workspaceStateMachine,
} from '@/backend/services/workspace';
import { deriveWorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';
import type { reconciliationService } from './reconciliation.service';
import type { initializeWorkspaceWorktree } from './workspace-init.orchestrator';

type SessionService = typeof sessionService;
type WorkspaceAutoIterationService = typeof workspaceAutoIterationService;

export type BridgeServices = {
  autoIterationService: typeof autoIterationService;
  chatEventForwarderService: typeof chatEventForwarderService;
  chatMessageHandlerService: typeof chatMessageHandlerService;
  createLogger: typeof createLogger;
  fixerSessionService: typeof fixerSessionService;
  getWorkspaceInitPolicy: typeof getWorkspaceInitPolicy;
  githubCLIService: typeof githubCLIService;
  initializeWorkspaceWorktree: typeof initializeWorkspaceWorktree;
  kanbanStateService: typeof kanbanStateService;
  logbookService: typeof logbookService;
  periodicTaskService: typeof periodicTaskService;
  prFetchRegistry: typeof prFetchRegistry;
  prSnapshotService: typeof prSnapshotService;
  ratchetService: typeof ratchetService;
  reconciliationService: typeof reconciliationService;
  sessionDataService: typeof sessionDataService;
  sessionDomainService: typeof sessionDomainService;
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
  workspaceRatchetService: typeof workspaceRatchetService;
  workspaceRunScriptService: typeof workspaceRunScriptService;
  workspaceSnapshotStore: typeof workspaceSnapshotStore;
  workspaceStateMachine: typeof workspaceStateMachine;
};

async function stopSessionBestEffort(
  sessionService: SessionService,
  sessionId: string
): Promise<void> {
  try {
    await sessionService.stopSession(sessionId);
  } catch {
    // Best-effort cleanup
  }
}

async function stopPreviousAutoIterationSession(
  sessionService: SessionService,
  sessionId: string
): Promise<void> {
  try {
    await sessionService.stopSession(sessionId);
  } catch (error) {
    if (!(error instanceof Error && /already stopped|not found/i.test(error.message))) {
      throw error;
    }
    // Session may already be stopped
  }
}

async function clearAutoIterationSessionIfMatching(
  workspaceAutoIterationService: WorkspaceAutoIterationService,
  workspaceId: string,
  sessionId: string
): Promise<void> {
  try {
    await workspaceAutoIterationService.clearSessionIfMatching(workspaceId, sessionId);
  } catch {
    // Preserve the original handoff or persistence error
  }
}

async function cleanupRecycledAutoIterationSession(
  sessionService: SessionService,
  workspaceAutoIterationService: WorkspaceAutoIterationService,
  workspaceId: string,
  sessionId: string
): Promise<void> {
  await stopSessionBestEffort(sessionService, sessionId);
  await clearAutoIterationSessionIfMatching(workspaceAutoIterationService, workspaceId, sessionId);
}

export function configureDomainBridges(services: BridgeServices): void {
  const {
    autoIterationService,
    chatEventForwarderService,
    chatMessageHandlerService,
    createLogger,
    fixerSessionService,
    getWorkspaceInitPolicy,
    githubCLIService,
    initializeWorkspaceWorktree,
    kanbanStateService,
    logbookService,
    periodicTaskService,
    prFetchRegistry,
    prSnapshotService,
    ratchetService,
    reconciliationService,
    sessionDataService,
    sessionDomainService,
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
    workspaceRatchetService,
    workspaceRunScriptService,
    workspaceSnapshotStore,
    workspaceStateMachine,
  } = services;
  const logger = createLogger('domain-bridges');

  // === Ratchet domain bridges ===
  const ratchetSessionBridge: RatchetSessionBridge = {
    findSessionById: (sessionId) => sessionDataService.findAgentSessionById(sessionId),
    findSessionsByWorkspaceId: (workspaceId) =>
      sessionDataService.findAgentSessionsByWorkspaceId(workspaceId),
    acquireFixerSession: (input) => sessionDataService.acquireFixerSession(input),
    isSessionRunning: (id) => sessionService.isSessionRunning(id),
    isSessionWorking: (id) => sessionService.isSessionWorking(id),
    stopSession: (id) => sessionService.stopSession(id),
    startSession: (id, opts) => sessionService.startSession(id, opts),
    restartSession: (id, opts) => sessionService.restartSession(id, opts),
    sendSessionMessage: (id, message) => sessionService.sendSessionMessage(id, message),
    injectCommittedUserMessage: (id, msg) =>
      sessionDomainService.injectCommittedUserMessage(id, msg),
  };

  const ratchetWorkspaceBridge = {
    findFixerContext: (workspaceId: string) => workspaceDataService.findFixerContext(workspaceId),
    recordSessionEnd: (workspaceId: string, sessionId: string, outcome: 'COMPLETED' | 'DIED') =>
      workspaceRatchetService.recordSessionEnd(workspaceId, sessionId, outcome),
  };

  const ratchetGithubBridge: RatchetGitHubBridge = {
    extractPRInfo: (url) => githubCLIService.extractPRInfo(url),
    getPRFullDetails: (repo, pr, signal) => githubCLIService.getPRFullDetails(repo, pr, signal),
    getReviewComments: (repo, pr, since, signal) =>
      githubCLIService.getReviewComments(repo, pr, since, signal),
    getResolvedReviewCommentIds: (repo, pr, signal) =>
      githubCLIService.getResolvedReviewCommentIds(repo, pr, signal),
    computeCIStatus: (checks) =>
      githubCLIService.computeCIStatus(
        checks?.map((c) => ({ ...c, conclusion: c.conclusion ?? undefined })) ?? null
      ),
    getAuthenticatedUsername: (signal) => githubCLIService.getAuthenticatedUsername(signal),
    fetchAndComputePRState: (prUrl) => githubCLIService.fetchAndComputePRState(prUrl),
    isRecentlyFetched: (workspaceId) => prFetchRegistry.isRecentlyFetched(workspaceId),
    isFetchInFlight: (workspaceId) => prFetchRegistry.isFetchInFlight(workspaceId),
    startFetch: (workspaceId) => prFetchRegistry.startFetch(workspaceId),
    registerFetch: (workspaceId, claimToken) => prFetchRegistry.register(workspaceId, claimToken),
    cancelFetch: (workspaceId, claimToken) => prFetchRegistry.cancelFetch(workspaceId, claimToken),
  };

  const ratchetSnapshotBridge: RatchetPRSnapshotBridge = {
    recordCIObservation: ({ workspaceId, ciStatus, failedAt, observedAt }) =>
      prSnapshotService.recordCIObservation(workspaceId, {
        ciStatus,
        failedAt,
        observedAt,
      }),
    recordCINotification: (workspaceId, notifiedAt) =>
      prSnapshotService.recordCINotification(workspaceId, notifiedAt),
    recordReviewCheck: (workspaceId, checkedAt) =>
      prSnapshotService.recordReviewCheck(workspaceId, { checkedAt }),
  };

  ratchetService.configure({
    session: ratchetSessionBridge,
    github: ratchetGithubBridge,
    snapshot: ratchetSnapshotBridge,
    workspace: ratchetWorkspaceBridge,
  });
  fixerSessionService.configure({
    session: ratchetSessionBridge,
    workspace: ratchetWorkspaceBridge,
  });
  reconciliationService.configure({
    workspace: {
      markFailed: async (id, reason) => {
        await workspaceStateMachine.markFailed(id, reason);
      },
      initializeWorktree: (id, options) => initializeWorkspaceWorktree(id, options),
      findNeedingWorktree: () => workspaceMaintenanceService.findNeedingWorktree(),
    },
    terminal: {
      recoverOrphanedSessions: () => terminalSessionService.recoverOrphanedSessions(),
    },
  });

  // === Workspace domain bridges ===
  kanbanStateService.configure({
    session: {
      isAnySessionWorking: (ids) => sessionService.isAnySessionWorking(ids),
      getAllPendingRequests: () => chatEventForwarderService.getAllPendingRequests(),
    },
  });

  workspaceQueryService.configure({
    session: {
      isAnySessionWorking: (ids) => sessionService.isAnySessionWorking(ids),
      getAllPendingRequests: () => chatEventForwarderService.getAllPendingRequests(),
      getRuntimeSnapshot: (id) => sessionService.getRuntimeSnapshot(id),
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
    kanban: {
      updateCachedKanbanColumn: (id) => kanbanStateService.updateCachedKanbanColumn(id),
    },
    workspace: {
      findPRContext: (id) => workspaceDataService.findPRContext(id),
      recordSnapshot: (id, data) => workspacePrSnapshotService.record(id, data),
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

  sessionService.configure({
    workspace: {
      markSessionRunning: (wsId, sId) => workspaceActivityService.markSessionRunning(wsId, sId),
      markSessionIdle: (wsId, sId, generation) =>
        workspaceActivityService.markSessionIdle(wsId, sId, generation),
      recordRatchetSessionEnd: (workspaceId, sessionId, outcome) =>
        ratchetService.recordSessionEnd(workspaceId, sessionId, outcome),
      resetPRDiscoveryBackoff: (workspaceId) =>
        workspaceDataService.resetPRDiscoveryBackoff(workspaceId),
    },
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
  sessionService.setPromptTurnCompleteHandler((sessionId) =>
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
        await sessionService.startSession(session.id, {
          initialPrompt: opts.initialPrompt,
          startupModePreset: opts.startupModePreset,
        });
      } catch (err) {
        // Clean up the session record if startup failed to prevent orphaned entries
        try {
          await sessionService.stopSession(session.id);
        } catch {
          // Best-effort cleanup
        }
        throw err;
      }
      return session.id;
    },
    async sendPrompt(sessionId, prompt, timeoutMs) {
      await sessionService.sendAcpMessage(sessionId, [{ type: 'text', text: prompt }], timeoutMs);
    },
    async waitForIdle(_sessionId) {
      // sendAcpMessage already blocks until the turn completes
    },
    async stopSession(sessionId) {
      await sessionService.stopSession(sessionId);
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
      if (ws?.autoIterationSessionId) {
        await stopPreviousAutoIterationSession(sessionService, ws.autoIterationSessionId);
      }
      const newSession = await sessionDataService.createAgentSession({
        workspaceId,
        name: 'Auto-iteration (recycled)',
        workflow: 'auto-iteration',
      });
      try {
        await sessionService.startSession(newSession.id, { startupModePreset: 'non_interactive' });
      } catch (err) {
        await stopSessionBestEffort(sessionService, newSession.id);
        throw err;
      }
      try {
        await workspaceAutoIterationService.setSession(workspaceId, newSession.id);
        await sessionService.sendAcpMessage(newSession.id, [{ type: 'text', text: handoffPrompt }]);
      } catch (err) {
        await cleanupRecycledAutoIterationSession(
          sessionService,
          workspaceAutoIterationService,
          workspaceId,
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
            sessionService.isAnySessionWorking(sessionIds) ||
            sessionIds.some(
              (sessionId) =>
                sessionService.isSessionRunning(sessionId) &&
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
    computeKanbanColumn: (input) => computeKanbanColumn(input),
    deriveSidebarStatus: (input) => deriveWorkspaceSidebarStatus(input),
  });
}

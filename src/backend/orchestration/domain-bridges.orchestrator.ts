/**
 * Domain Bridge Wiring
 *
 * Single entry point that configures all cross-domain bridges at application startup.
 * Must be called BEFORE any domain service is used.
 *
 * Import graph: orchestration -> all 6 domain barrels
 * Domain services never import each other; they receive capabilities via bridges.
 */

import type { Prisma } from '@prisma-gen/client';
import {
  type AutoIterationSessionBridge,
  type AutoIterationWorkspaceBridge,
  autoIterationService,
} from '@/backend/services/auto-iteration';
import { githubCLIService, prSnapshotService } from '@/backend/services/github';
import {
  fixerSessionService,
  type RatchetGitHubBridge,
  type RatchetPRSnapshotBridge,
  type RatchetSessionBridge,
  ratchetService,
  reconciliationService,
} from '@/backend/services/ratchet';
import { startupScriptService } from '@/backend/services/run-script';
import {
  chatEventForwarderService,
  chatMessageHandlerService,
  sessionDataService,
  sessionDomainService,
  sessionService,
} from '@/backend/services/session';
import {
  computeKanbanColumn,
  deriveWorkspaceFlowState,
  getWorkspaceInitPolicy,
  kanbanStateService,
  type WorkspaceInitPolicyInput,
  workspaceAccessor,
  workspaceActivityService,
  workspaceQueryService,
  workspaceStateMachine,
} from '@/backend/services/workspace';
import { workspaceSnapshotStore } from '@/backend/services/workspace-snapshot-store.service';
import { deriveWorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';
import { initializeWorkspaceWorktree } from './workspace-init.orchestrator';

type BridgeServices = {
  chatEventForwarderService: typeof chatEventForwarderService;
  chatMessageHandlerService: typeof chatMessageHandlerService;
  fixerSessionService: typeof fixerSessionService;
  getWorkspaceInitPolicy: typeof getWorkspaceInitPolicy;
  githubCLIService: typeof githubCLIService;
  kanbanStateService: typeof kanbanStateService;
  prSnapshotService: typeof prSnapshotService;
  ratchetService: typeof ratchetService;
  reconciliationService: typeof reconciliationService;
  sessionDataService: typeof sessionDataService;
  sessionDomainService: typeof sessionDomainService;
  sessionService: typeof sessionService;
  startupScriptService: typeof startupScriptService;
  workspaceAccessor: typeof workspaceAccessor;
  workspaceActivityService: typeof workspaceActivityService;
  workspaceQueryService: typeof workspaceQueryService;
  workspaceSnapshotStore: typeof workspaceSnapshotStore;
  workspaceStateMachine: typeof workspaceStateMachine;
};

const defaultServices: BridgeServices = {
  chatEventForwarderService,
  chatMessageHandlerService,
  fixerSessionService,
  getWorkspaceInitPolicy,
  githubCLIService,
  kanbanStateService,
  prSnapshotService,
  ratchetService,
  reconciliationService,
  sessionDataService,
  sessionDomainService,
  sessionService,
  startupScriptService,
  workspaceAccessor,
  workspaceActivityService,
  workspaceQueryService,
  workspaceSnapshotStore,
  workspaceStateMachine,
};

export function configureDomainBridges(services: Partial<BridgeServices> = {}): void {
  const resolved = { ...defaultServices, ...services };
  const {
    chatEventForwarderService,
    chatMessageHandlerService,
    fixerSessionService,
    getWorkspaceInitPolicy,
    githubCLIService,
    kanbanStateService,
    prSnapshotService,
    ratchetService,
    reconciliationService,
    sessionDataService,
    sessionDomainService,
    sessionService,
    startupScriptService,
    workspaceAccessor,
    workspaceActivityService,
    workspaceQueryService,
    workspaceSnapshotStore,
    workspaceStateMachine,
  } = resolved;

  // === Ratchet domain bridges ===
  const ratchetSessionBridge: RatchetSessionBridge = {
    isSessionRunning: (id) => sessionService.isSessionRunning(id),
    isSessionWorking: (id) => sessionService.isSessionWorking(id),
    stopSession: (id) => sessionService.stopSession(id),
    startSession: (id, opts) => sessionService.startSession(id, opts),
    sendSessionMessage: (id, message) => sessionService.sendSessionMessage(id, message),
    injectCommittedUserMessage: (id, msg) =>
      sessionDomainService.injectCommittedUserMessage(id, msg),
  };

  const ratchetGithubBridge: RatchetGitHubBridge = {
    extractPRInfo: (url) => githubCLIService.extractPRInfo(url),
    getPRFullDetails: (repo, pr) => githubCLIService.getPRFullDetails(repo, pr),
    getReviewComments: (repo, pr) => githubCLIService.getReviewComments(repo, pr),
    computeCIStatus: (checks) =>
      githubCLIService.computeCIStatus(
        checks?.map((c) => ({ ...c, conclusion: c.conclusion ?? undefined })) ?? null
      ),
    getAuthenticatedUsername: () => githubCLIService.getAuthenticatedUsername(),
    fetchAndComputePRState: (prUrl) => githubCLIService.fetchAndComputePRState(prUrl),
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
  });
  fixerSessionService.configure({ session: ratchetSessionBridge });
  reconciliationService.configure({
    workspace: {
      markFailed: async (id, reason) => {
        await workspaceStateMachine.markFailed(id, reason);
      },
      initializeWorktree: (id, options) => initializeWorkspaceWorktree(id, options),
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
  });

  // === Session domain bridges ===
  chatEventForwarderService.configure({
    workspace: {
      markSessionRunning: (wsId, sId) => workspaceActivityService.markSessionRunning(wsId, sId),
      markSessionIdle: (wsId, sId) => workspaceActivityService.markSessionIdle(wsId, sId),
      on: (event, handler) => workspaceActivityService.on(event, handler),
    },
  });

  sessionService.configure({
    workspace: {
      markSessionRunning: (wsId, sId) => workspaceActivityService.markSessionRunning(wsId, sId),
      markSessionIdle: (wsId, sId) => workspaceActivityService.markSessionIdle(wsId, sId),
      clearRatchetActiveSessionIfMatching: (workspaceId, sessionId) =>
        ratchetService.clearRatchetActiveSessionIfMatching(workspaceId, sessionId),
    },
  });

  chatMessageHandlerService.configure({
    initPolicy: {
      getWorkspaceInitPolicy: (input) => getWorkspaceInitPolicy(input as WorkspaceInitPolicyInput),
    },
  });
  sessionService.setPromptTurnCompleteHandler((sessionId) =>
    chatMessageHandlerService.tryDispatchNextMessage(sessionId)
  );

  // === Run-script domain bridges ===
  startupScriptService.configure({
    workspace: {
      markReady: (id) => workspaceStateMachine.markReady(id),
      markFailed: (id, msg) => workspaceStateMachine.markFailed(id, msg),
    },
  });

  // === Auto-iteration domain bridges ===
  const autoIterationWorkspaceBridge: AutoIterationWorkspaceBridge = {
    async getWorktreePath(workspaceId) {
      const ws = await workspaceAccessor.findRawById(workspaceId);
      if (!ws?.worktreePath) {
        throw new Error(`Workspace ${workspaceId} has no worktree path`);
      }
      return ws.worktreePath;
    },
    async updateAutoIterationStatus(workspaceId, status) {
      await workspaceAccessor.update(workspaceId, { autoIterationStatus: status });
    },
    async updateAutoIterationProgress(workspaceId, progress) {
      await workspaceAccessor.update(workspaceId, {
        autoIterationProgress: progress as unknown as Prisma.InputJsonValue,
      });
    },
    async updateAutoIterationSessionId(workspaceId, sessionId) {
      await workspaceAccessor.update(workspaceId, { autoIterationSessionId: sessionId });
    },
  };

  const autoIterationSessionBridge: AutoIterationSessionBridge = {
    async startSession(workspaceId, opts) {
      const session = await sessionDataService.createAgentSession({
        workspaceId,
        name: 'Auto-iteration',
        workflow: 'auto-iteration',
      });
      await sessionService.startSession(session.id, {
        initialPrompt: opts.initialPrompt,
        startupModePreset: opts.startupModePreset,
      });
      return session.id;
    },
    async sendPrompt(sessionId, prompt) {
      await sessionService.sendAcpMessage(sessionId, [{ type: 'text', text: prompt }]);
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
      const ws = await workspaceAccessor.findRawById(workspaceId);
      if (ws?.autoIterationSessionId) {
        try {
          await sessionService.stopSession(ws.autoIterationSessionId);
        } catch {
          // Session may already be stopped
        }
      }
      const newSession = await sessionDataService.createAgentSession({
        workspaceId,
        name: 'Auto-iteration (recycled)',
        workflow: 'auto-iteration',
      });
      await sessionService.startSession(newSession.id, { startupModePreset: 'non_interactive' });
      await sessionService.sendAcpMessage(newSession.id, [{ type: 'text', text: handoffPrompt }]);
      return newSession.id;
    },
  };

  autoIterationService.configure(autoIterationSessionBridge, autoIterationWorkspaceBridge);

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

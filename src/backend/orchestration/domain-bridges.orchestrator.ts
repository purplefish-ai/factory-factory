/**
 * Domain Bridge Wiring
 *
 * Single entry point that configures all cross-domain bridges at application startup.
 * Must be called BEFORE any domain service is used.
 *
 * Import graph: orchestration -> all 6 domain barrels
 * Domain services never import each other; they receive capabilities via bridges.
 */

import { githubCLIService, prSnapshotService } from '@/backend/domains/github';
import {
  fixerSessionService,
  type RatchetGitHubBridge,
  type RatchetPRSnapshotBridge,
  type RatchetSessionBridge,
  ratchetService,
  reconciliationService,
} from '@/backend/domains/ratchet';
import { startupScriptService } from '@/backend/domains/run-script';
import {
  chatEventForwarderService,
  chatMessageHandlerService,
  sessionDomainService,
  sessionService,
} from '@/backend/domains/session';
import {
  computeKanbanColumn,
  deriveWorkspaceFlowState,
  getWorkspaceInitPolicy,
  kanbanStateService,
  type WorkspaceInitPolicyInput,
  workspaceActivityService,
  workspaceQueryService,
  workspaceStateMachine,
} from '@/backend/domains/workspace';
import { workspaceSnapshotStore } from '@/backend/services/workspace-snapshot-store.service';
import { deriveWorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';

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
  sessionDomainService: typeof sessionDomainService;
  sessionService: typeof sessionService;
  startupScriptService: typeof startupScriptService;
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
  sessionDomainService,
  sessionService,
  startupScriptService,
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
    sessionDomainService,
    sessionService,
    startupScriptService,
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

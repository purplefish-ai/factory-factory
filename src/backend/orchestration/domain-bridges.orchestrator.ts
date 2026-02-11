/**
 * Domain Bridge Wiring
 *
 * Single entry point that configures all cross-domain bridges at application startup.
 * Must be called BEFORE any domain service is used.
 *
 * Import graph: orchestration -> all 6 domain barrels
 * Domain services never import each other; they receive capabilities via bridges.
 */

import {
  githubCLIService,
  prReviewFixerService,
  prSnapshotService,
} from '@/backend/domains/github';
import {
  ciFixerService,
  ciMonitorService,
  fixerSessionService,
  type RatchetGitHubBridge,
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
import { workspaceSnapshotStore } from '@/backend/services';
import { deriveWorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';

export function configureDomainBridges(): void {
  // === Ratchet domain bridges ===
  const ratchetSessionBridge: RatchetSessionBridge = {
    isSessionRunning: (id) => sessionService.isSessionRunning(id),
    isSessionWorking: (id) => sessionService.isSessionWorking(id),
    stopClaudeSession: (id) => sessionService.stopClaudeSession(id),
    startClaudeSession: (id, opts) => sessionService.startClaudeSession(id, opts),
    getClient: (id) => sessionService.getClient(id) ?? null,
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

  ratchetService.configure({ session: ratchetSessionBridge, github: ratchetGithubBridge });
  fixerSessionService.configure({ session: ratchetSessionBridge });
  ciFixerService.configure({ session: ratchetSessionBridge });
  ciMonitorService.configure({ session: ratchetSessionBridge, github: ratchetGithubBridge });
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
  prReviewFixerService.configure({
    session: {
      isSessionWorking: (id) => sessionService.isSessionWorking(id),
      getClient: (id) => sessionService.getClient(id) ?? null,
    },
    fixer: {
      acquireAndDispatch: (input) => fixerSessionService.acquireAndDispatch(input),
      getActiveSession: (wsId, wf) => fixerSessionService.getActiveSession(wsId, wf),
    },
  });

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

  chatMessageHandlerService.configure({
    initPolicy: {
      getWorkspaceInitPolicy: (input) => getWorkspaceInitPolicy(input as WorkspaceInitPolicyInput),
    },
  });

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

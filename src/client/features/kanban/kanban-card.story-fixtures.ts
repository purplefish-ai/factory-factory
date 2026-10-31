import { deriveWorkspacePRSummary } from '@/shared/workspace-pr-summary';
import type { WorkspaceWithKanban } from './kanban-card';

/**
 * One row of the shared project workspace list. Exported so the board and
 * column stories build on the same shape the endpoint actually returns.
 */
export const baseWorkspace: WorkspaceWithKanban = {
  id: 'ws-1',
  projectId: 'proj-1',
  name: 'Add user authentication',
  status: 'READY',
  worktreePath: '/tmp/story-worktree',
  createdAt: new Date(),
  branchName: 'feature/auth',
  initErrorMessage: null,
  prs: [],
  prSummary: deriveWorkspacePRSummary([], true),
  prUrl: null,
  prNumber: null,
  prState: 'NONE',
  prCiStatus: 'UNKNOWN',
  ratchetEnabled: true,
  prMonitoring: {
    deliveryMode: 'MAIN',
    enabled: true,
    recipientSessionId: null,
    bindingRevision: 0,
    pauseReason: null,
    pendingEventCount: 0,
  },
  ratchetState: 'IDLE',
  runScriptStatus: 'IDLE',
  githubIssueNumber: null,
  githubIssueUrl: null,
  linearIssueId: null,
  linearIssueIdentifier: null,
  linearIssueUrl: null,
  creationSource: 'MANUAL',
  sessionSummaries: [],
  pendingRequestType: null,
  gitStats: null,
  lastActivityAt: null,
  isWorking: false,
  kanbanColumn: 'WORKING',
  sidebarStatus: { activityState: 'IDLE', ciState: 'NONE' },
  ratchetButtonAnimated: false,
  flowPhase: 'NO_PR',
  ciObservation: 'NOT_FETCHED',
  statusReason: {
    code: 'READY_FOR_NEXT_PROMPT',
    label: 'Ready',
    tone: 'neutral',
    needsUser: false,
  },
};

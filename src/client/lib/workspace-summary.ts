import { kanbanColumnForStatusReason } from '@/shared/kanban-column-projection';
import { deriveWorkspacePRSummary } from '@/shared/workspace-pr-summary';
import type { WorkspaceSummary } from '@/shared/workspace-summary';

/** One complete optimistic list row; detail hydration retains its own extra fields. */
export function createOptimisticWorkspaceSummary(params: {
  id: string;
  projectId: string;
  name: string;
  ratchetEnabled: boolean;
  createdAt?: Date;
}): WorkspaceSummary<Date> {
  return {
    id: params.id,
    projectId: params.projectId,
    name: params.name,
    status: 'NEW',
    createdAt: params.createdAt ?? new Date(),
    branchName: null,
    worktreePath: null,
    initErrorMessage: null,
    prs: [],
    prSummary: deriveWorkspacePRSummary([], params.ratchetEnabled),
    prUrl: null,
    prNumber: null,
    prState: 'NONE',
    prCiStatus: 'UNKNOWN',
    ratchetEnabled: params.ratchetEnabled,
    prMonitoring: {
      deliveryMode: 'MAIN',
      enabled: params.ratchetEnabled,
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
    isWorking: true,
    kanbanColumn: kanbanColumnForStatusReason('SETTING_UP'),
    sidebarStatus: { activityState: 'WORKING', ciState: 'NONE' },
    ratchetButtonAnimated: false,
    flowPhase: 'NO_PR',
    ciObservation: 'NOT_FETCHED',
    statusReason: {
      code: 'SETTING_UP',
      label: 'Setting up workspace',
      tone: 'working',
      needsUser: false,
    },
  };
}

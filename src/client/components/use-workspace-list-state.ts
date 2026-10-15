import type { CIStatus, PRState, RatchetState, RunScriptStatus } from '@/shared/core';
import type { PRMonitoringProjection } from '@/shared/pr-monitoring';
import type { SessionSummary } from '@/shared/session-runtime';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';
import type { WorkspacePRSummary } from '@/shared/workspace-pr-summary';
import type { WorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';
import type { WorkspaceStatusReason } from '@/shared/workspace-status-reason';

export interface ServerWorkspace {
  id: string;
  projectId?: string;
  worktreePath?: string | null;
  status?: string;
  name: string;
  createdAt: string | Date;
  branchName?: string | null;
  prs?: WorkspacePullRequest[];
  prSummary?: WorkspacePRSummary;
  prUrl?: string | null;
  prNumber?: number | null;
  prState?: PRState | null;
  prCiStatus?: CIStatus | null;
  isWorking: boolean;
  sessionSummaries?: SessionSummary[];
  gitStats: {
    total: number;
    additions: number;
    deletions: number;
    hasUncommitted: boolean;
  } | null;
  lastActivityAt?: string | null;
  ratchetEnabled?: boolean;
  prMonitoring?: PRMonitoringProjection;
  ratchetState?: RatchetState | null;
  ratchetButtonAnimated?: boolean;
  flowPhase?: string | null;
  ciObservation?: string | null;
  statusReason?: WorkspaceStatusReason | null;
  runScriptStatus?: RunScriptStatus | null;
  kanbanColumn?: string | null;
  sidebarStatus?: WorkspaceSidebarStatus;
  pendingRequestType?: 'plan_approval' | 'user_question' | 'permission_request' | null;
  githubIssueNumber?: number | null;
  githubIssueUrl?: string | null;
  linearIssueId?: string | null;
  linearIssueIdentifier?: string | null;
  linearIssueUrl?: string | null;
  creationSource?: string | null;
}

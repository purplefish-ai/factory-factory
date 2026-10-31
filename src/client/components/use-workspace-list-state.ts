import type { WorkspaceSummary } from '@/shared/workspace-summary';

/** The sidebar consumes a required slice of the same contract as the board. */
export type ServerWorkspace = Pick<
  WorkspaceSummary<string | Date>,
  | 'id'
  | 'projectId'
  | 'worktreePath'
  | 'status'
  | 'name'
  | 'conversationSummary'
  | 'createdAt'
  | 'branchName'
  | 'prs'
  | 'prUrl'
  | 'prNumber'
  | 'prState'
  | 'prCiStatus'
  | 'isWorking'
  | 'gitStats'
  | 'prMonitoring'
  | 'kanbanColumn'
  | 'pendingRequestType'
  | 'githubIssueNumber'
  | 'githubIssueUrl'
  | 'linearIssueId'
  | 'linearIssueIdentifier'
  | 'linearIssueUrl'
  | 'creationSource'
  | 'statusReason'
>;

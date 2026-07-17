import { WorkspaceStatus } from '@/shared/core';

type IssueKey = number | string;

/**
 * Authoritative durable policy for whether linked issues are available to start.
 * Clients may additionally hide issues only to reconcile transient optimistic or
 * cache-skew state; they must not redefine workspace-status eligibility.
 */
export function filterIssuesLinkedToActiveWorkspaces<
  TIssue,
  TWorkspace extends { status: WorkspaceStatus },
  TIssueKey extends IssueKey,
>(
  issues: TIssue[],
  workspaces: TWorkspace[],
  getWorkspaceIssueKey: (workspace: TWorkspace) => TIssueKey | null | undefined,
  getIssueKey: (issue: TIssue) => TIssueKey
): TIssue[] {
  const linkedIssueKeys = new Set<TIssueKey>();

  for (const workspace of workspaces) {
    if (
      workspace.status === WorkspaceStatus.ARCHIVING ||
      workspace.status === WorkspaceStatus.ARCHIVED
    ) {
      continue;
    }

    const issueKey = getWorkspaceIssueKey(workspace);
    if (issueKey != null) {
      linkedIssueKeys.add(issueKey);
    }
  }

  if (linkedIssueKeys.size === 0) {
    return issues;
  }

  return issues.filter((issue) => !linkedIssueKeys.has(getIssueKey(issue)));
}

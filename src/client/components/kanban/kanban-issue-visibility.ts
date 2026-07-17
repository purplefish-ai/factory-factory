import type { NormalizedIssue } from '@/client/lib/issue-normalization';
import { IssueProvider } from '@/shared/core';

export interface WorkspaceIssueLink {
  githubIssueNumber: number | null;
  linearIssueId: string | null;
}

function collectLinkedIssueKeys<TKey extends number | string>(
  workspaces: readonly WorkspaceIssueLink[] | undefined,
  archivingWorkspaceIssueLinks: ReadonlyMap<string, WorkspaceIssueLink>,
  getIssueKey: (link: WorkspaceIssueLink) => TKey | null
): Set<TKey> {
  const issueKeys = new Set<TKey>();
  for (const workspace of workspaces ?? []) {
    const issueKey = getIssueKey(workspace);
    if (issueKey !== null) {
      issueKeys.add(issueKey);
    }
  }
  for (const link of archivingWorkspaceIssueLinks.values()) {
    const issueKey = getIssueKey(link);
    if (issueKey !== null) {
      issueKeys.add(issueKey);
    }
  }
  return issueKeys;
}

/**
 * Reconciles a potentially stale provider query with newer client workspace state.
 *
 * Durable linked-workspace eligibility belongs to the backend provider routers.
 * This client-only filter prevents duplicate issue/workspace cards while a newly
 * created workspace reaches the live cache or an optimistic archive is in flight.
 */
export function filterIssuesForCurrentWorkspaceState(
  issues: NormalizedIssue[] | undefined,
  issueProvider: IssueProvider,
  workspaces: readonly WorkspaceIssueLink[] | undefined,
  archivingWorkspaceIssueLinks: ReadonlyMap<string, WorkspaceIssueLink>
): NormalizedIssue[] | undefined {
  if (!issues) {
    return undefined;
  }

  if (issueProvider === IssueProvider.LINEAR) {
    const linkedIssueIds = collectLinkedIssueKeys(
      workspaces,
      archivingWorkspaceIssueLinks,
      (link) => link.linearIssueId
    );
    return issues.filter(
      (issue) => issue.linearIssueId === undefined || !linkedIssueIds.has(issue.linearIssueId)
    );
  }

  const linkedIssueNumbers = collectLinkedIssueKeys(
    workspaces,
    archivingWorkspaceIssueLinks,
    (link) => link.githubIssueNumber
  );
  return issues.filter(
    (issue) =>
      issue.githubIssueNumber === undefined || !linkedIssueNumbers.has(issue.githubIssueNumber)
  );
}

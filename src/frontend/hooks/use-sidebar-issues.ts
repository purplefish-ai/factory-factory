import { useMemo } from 'react';
import type { ServerWorkspace } from '@/frontend/components/use-workspace-list-state';
import {
  type NormalizedIssue,
  normalizeGitHubIssue,
  normalizeLinearIssue,
} from '@/frontend/lib/issue-normalization';
import { trpc } from '@/frontend/lib/trpc';

/**
 * Fetches and normalizes GitHub/Linear issues for the sidebar Todo section.
 * Filters out issues that already have workspaces (same logic as KanbanProvider).
 */
export function useSidebarIssues(
  projectId: string | undefined,
  issueProvider: string,
  serverWorkspaces: ServerWorkspace[] | undefined
): { issues: NormalizedIssue[] | undefined; isLoading: boolean } {
  const isLinear = issueProvider === 'LINEAR';

  const { data: githubData, isLoading: isLoadingGithub } =
    trpc.github.listIssuesForProject.useQuery(
      { projectId: projectId ?? '' },
      { refetchInterval: 60_000, staleTime: 30_000, enabled: !!projectId && !isLinear }
    );

  const { data: linearData, isLoading: isLoadingLinear } =
    trpc.linear.listIssuesForProject.useQuery(
      { projectId: projectId ?? '' },
      { refetchInterval: 60_000, staleTime: 30_000, enabled: !!projectId && isLinear }
    );

  const isLoading = isLinear ? isLoadingLinear : isLoadingGithub;

  const normalizedIssues = useMemo(() => {
    if (isLinear) {
      return linearData?.issues?.map(normalizeLinearIssue);
    }
    return githubData?.issues?.map(normalizeGitHubIssue);
  }, [isLinear, githubData?.issues, linearData?.issues]);

  // Filter out issues that already have workspaces
  const filteredIssues = useMemo(() => {
    if (!normalizedIssues) {
      return undefined;
    }
    if (!serverWorkspaces) {
      return normalizedIssues;
    }

    if (isLinear) {
      const workspaceLinearIds = new Set(
        serverWorkspaces.map((w) => w.linearIssueId).filter((id): id is string => !!id)
      );
      return normalizedIssues.filter(
        (issue) => !(issue.linearIssueId && workspaceLinearIds.has(issue.linearIssueId))
      );
    }

    const workspaceIssueNumbers = new Set(
      serverWorkspaces.map((w) => w.githubIssueNumber).filter((n): n is number => n != null)
    );
    return normalizedIssues.filter(
      (issue) => !(issue.githubIssueNumber && workspaceIssueNumbers.has(issue.githubIssueNumber))
    );
  }, [normalizedIssues, serverWorkspaces, isLinear]);

  return { issues: filteredIssues, isLoading };
}

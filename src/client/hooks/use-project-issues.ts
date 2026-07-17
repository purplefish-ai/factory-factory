import { useEffect, useMemo } from 'react';
import {
  shouldSyncGitHubCLIHealthFromIssuesResponse,
  syncGitHubCLIHealth,
} from '@/client/lib/cli-health-cache';
import { normalizeGitHubIssue, normalizeLinearIssue } from '@/client/lib/issue-normalization';
import {
  filterIssuesForCurrentWorkspaceState,
  type WorkspaceIssueLink,
} from '@/client/lib/project-issue-visibility';
import { trpc } from '@/client/lib/trpc';
import { IssueProvider } from '@/shared/core';

const PROJECT_ISSUES_QUERY_TIMING = {
  refetchInterval: 60_000,
  staleTime: 30_000,
} as const;

const NO_OPTIMISTIC_WORKSPACE_ISSUE_LINKS = new Map<string, WorkspaceIssueLink>();

interface ProjectIssuesClientState {
  workspaceIssueLinks: readonly WorkspaceIssueLink[] | undefined;
  optimisticWorkspaceIssueLinks?: ReadonlyMap<string, WorkspaceIssueLink>;
}

export function useProjectIssues(
  projectId: string | undefined,
  issueProvider: IssueProvider,
  clientState: ProjectIssuesClientState
) {
  const isLinear = issueProvider === IssueProvider.LINEAR;
  const utils = trpc.useUtils();

  const githubQuery = trpc.github.listIssuesForProject.useQuery(
    { projectId: projectId ?? '' },
    {
      ...PROJECT_ISSUES_QUERY_TIMING,
      enabled: !!projectId && !isLinear,
    }
  );
  const linearQuery = trpc.linear.listIssuesForProject.useQuery(
    { projectId: projectId ?? '' },
    {
      ...PROJECT_ISSUES_QUERY_TIMING,
      enabled: !!projectId && isLinear,
    }
  );

  useEffect(() => {
    if (!githubQuery.data?.health) {
      return;
    }

    if (
      !shouldSyncGitHubCLIHealthFromIssuesResponse(githubQuery.data.health, githubQuery.data.error)
    ) {
      return;
    }

    syncGitHubCLIHealth(utils.admin.checkCLIHealth, githubQuery.data.health);
  }, [githubQuery.data?.error, githubQuery.data?.health, utils.admin.checkCLIHealth]);

  const normalizedIssues = useMemo(() => {
    if (isLinear) {
      return linearQuery.data?.issues.map(normalizeLinearIssue);
    }
    return githubQuery.data?.issues.map(normalizeGitHubIssue);
  }, [githubQuery.data?.issues, isLinear, linearQuery.data?.issues]);

  const issues = useMemo(
    () =>
      filterIssuesForCurrentWorkspaceState(
        normalizedIssues,
        issueProvider,
        clientState.workspaceIssueLinks,
        clientState.optimisticWorkspaceIssueLinks ?? NO_OPTIMISTIC_WORKSPACE_ISSUE_LINKS
      ),
    [
      clientState.optimisticWorkspaceIssueLinks,
      clientState.workspaceIssueLinks,
      issueProvider,
      normalizedIssues,
    ]
  );

  if (isLinear) {
    return {
      issues,
      isLoading: linearQuery.isLoading,
      refetch: linearQuery.refetch,
    };
  }

  return {
    issues,
    isLoading: githubQuery.isLoading,
    refetch: githubQuery.refetch,
  };
}

import { useEffect, useMemo } from 'react';
import {
  shouldSyncGitHubCLIHealthFromIssuesResponse,
  syncGitHubCLIHealth,
} from '@/client/lib/cli-health-cache';
import { normalizeGitHubIssue, normalizeLinearIssue } from '@/client/lib/issue-normalization';
import { trpc } from '@/client/lib/trpc';
import { IssueProvider } from '@/shared/core';

const PROJECT_ISSUES_QUERY_TIMING = {
  refetchInterval: 60_000,
  staleTime: 30_000,
} as const;

export function useProjectIssues(projectId: string | undefined, issueProvider: IssueProvider) {
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

  const issues = useMemo(() => {
    if (isLinear) {
      return linearQuery.data?.issues.map(normalizeLinearIssue);
    }
    return githubQuery.data?.issues.map(normalizeGitHubIssue);
  }, [githubQuery.data?.issues, isLinear, linearQuery.data?.issues]);

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

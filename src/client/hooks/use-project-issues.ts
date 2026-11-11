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
import { POLL_INTERVAL_MS } from '@/client/lib/query-options';
import { trpc } from '@/client/lib/trpc';
import { IssueProvider } from '@/shared/core';

const PROJECT_ISSUES_QUERY_TIMING = {
  refetchInterval: POLL_INTERVAL_MS.external,
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
  const isGitHubQueryEnabled = !!projectId && !isLinear;
  const utils = trpc.useUtils();

  const githubQuery = trpc.github.listIssuesForProject.useQuery(
    { projectId: projectId ?? '' },
    {
      ...PROJECT_ISSUES_QUERY_TIMING,
      enabled: isGitHubQueryEnabled,
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
    if (!(isGitHubQueryEnabled && githubQuery.data?.health)) {
      return;
    }

    if (
      !shouldSyncGitHubCLIHealthFromIssuesResponse(githubQuery.data.health, githubQuery.data.error)
    ) {
      return;
    }

    syncGitHubCLIHealth(utils.admin.checkCLIHealth, githubQuery.data.health);
  }, [
    githubQuery.data?.error,
    githubQuery.data?.health,
    isGitHubQueryEnabled,
    utils.admin.checkCLIHealth,
  ]);

  const normalizedIssues = useMemo(() => {
    if (isLinear) {
      return linearQuery.data?.issues?.map(normalizeLinearIssue);
    }
    return githubQuery.data?.issues?.map(normalizeGitHubIssue);
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

  const query = isLinear ? linearQuery : githubQuery;
  const responseError = query.data?.error;
  const health = githubQuery.data?.health;
  const notConnected = isLinear
    ? responseError === 'Linear not configured for this project'
    : responseError === 'Project is not linked to a GitHub repository' ||
      Boolean(health && !(health.isInstalled && health.isAuthenticated));
  const error = query.error?.message ?? responseError ?? null;
  const status = projectId
    ? getIssuesStatus(notConnected, error, query.isLoading || !query.data)
    : 'no-project';

  return {
    issues: projectId ? issues : undefined,
    isLoading: Boolean(projectId) && query.isLoading,
    isFetching: Boolean(projectId) && query.isFetching,
    status,
    error,
    refetch: query.refetch,
  };
}

export type ProjectIssuesStatus = 'loading' | 'not-connected' | 'error' | 'ready' | 'no-project';

function getIssuesStatus(
  notConnected: boolean,
  error: string | null,
  loading: boolean
): ProjectIssuesStatus {
  if (notConnected) {
    return 'not-connected';
  }
  if (error) {
    return 'error';
  }
  return loading ? 'loading' : 'ready';
}

import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import { trpc } from '@/frontend/lib/trpc';
import type { WorkspaceWithKanban } from './kanban-card';

/** Normalized issue type that works for both GitHub and Linear providers. */
export interface KanbanIssue {
  id: string;
  displayId: string;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  author: string;
  provider: 'github' | 'linear';
  githubIssueNumber?: number;
  linearIssueId?: string;
  linearIssueIdentifier?: string;
}

/** Raw GitHub issue shape from the tRPC response. */
interface GitHubIssueRaw {
  number: number;
  title: string;
  body: string;
  url: string;
  state: 'OPEN' | 'CLOSED';
  createdAt: string;
  author: { login: string };
}

/** Raw Linear issue shape from the tRPC response. */
interface LinearIssueRaw {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  state: string;
  createdAt: string;
  assigneeName: string | null;
}

function normalizeGitHubIssue(issue: GitHubIssueRaw): KanbanIssue {
  return {
    id: String(issue.number),
    displayId: `#${issue.number}`,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    createdAt: issue.createdAt,
    author: issue.author.login,
    provider: 'github',
    githubIssueNumber: issue.number,
  };
}

function normalizeLinearIssue(issue: LinearIssueRaw): KanbanIssue {
  return {
    id: issue.id,
    displayId: issue.identifier,
    title: issue.title,
    body: issue.description,
    url: issue.url,
    createdAt: issue.createdAt,
    author: issue.assigneeName ?? 'Unassigned',
    provider: 'linear',
    linearIssueId: issue.id,
    linearIssueIdentifier: issue.identifier,
  };
}

interface KanbanContextValue {
  projectId: string;
  projectSlug: string;
  issueProvider: string;
  workspaces: WorkspaceWithKanban[] | undefined;
  issues: KanbanIssue[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: { message: string } | null;
  refetch: () => void;
  syncAndRefetch: () => Promise<void>;
  isSyncing: boolean;
  toggleWorkspaceRatcheting: (workspaceId: string, enabled: boolean) => Promise<void>;
  togglingWorkspaceId: string | null;
  archiveWorkspace: (workspaceId: string, commitUncommitted: boolean) => Promise<void>;
  archivingWorkspaceId: string | null;
  onCreateWorkspace?: () => void;
  isCreatingWorkspace?: boolean;
}

const KanbanContext = createContext<KanbanContextValue | null>(null);

export function useKanban() {
  const context = useContext(KanbanContext);
  if (!context) {
    throw new Error('useKanban must be used within a KanbanProvider');
  }
  return context;
}

interface KanbanProviderProps {
  projectId: string;
  projectSlug: string;
  issueProvider: string;
  onCreateWorkspace?: () => void;
  isCreatingWorkspace?: boolean;
  children: ReactNode;
}

export function KanbanProvider({
  projectId,
  projectSlug,
  issueProvider,
  onCreateWorkspace,
  isCreatingWorkspace,
  children,
}: KanbanProviderProps) {
  const utils = trpc.useUtils();
  const isLinear = issueProvider === 'LINEAR';

  const {
    data: workspaces,
    isLoading: isLoadingWorkspaces,
    isError: isErrorWorkspaces,
    error: errorWorkspaces,
    refetch: refetchWorkspaces,
  } = trpc.workspace.listWithKanbanState.useQuery(
    { projectId },
    { refetchInterval: 30_000, staleTime: 25_000 }
  );

  // GitHub issues — enabled only when provider is GitHub
  const {
    data: githubIssuesData,
    isLoading: isLoadingGithubIssues,
    refetch: refetchGithubIssues,
  } = trpc.github.listIssuesForProject.useQuery(
    { projectId },
    { refetchInterval: 60_000, staleTime: 30_000, enabled: !isLinear }
  );

  // Linear issues — enabled only when provider is Linear
  const {
    data: linearIssuesData,
    isLoading: isLoadingLinearIssues,
    refetch: refetchLinearIssues,
  } = trpc.linear.listIssuesForProject.useQuery(
    { projectId },
    { refetchInterval: 60_000, staleTime: 30_000, enabled: isLinear }
  );

  const isLoadingIssues = isLinear ? isLoadingLinearIssues : isLoadingGithubIssues;

  const syncMutation = trpc.workspace.syncAllPRStatuses.useMutation();
  const toggleRatchetingMutation = trpc.workspace.toggleRatcheting.useMutation();
  const archiveMutation = trpc.workspace.archive.useMutation();
  const [togglingWorkspaceId, setTogglingWorkspaceId] = useState<string | null>(null);
  const [archivingWorkspaceId, setArchivingWorkspaceId] = useState<string | null>(null);

  const refetchIssues = isLinear ? refetchLinearIssues : refetchGithubIssues;

  const syncAndRefetch = async () => {
    await syncMutation.mutateAsync({ projectId });
    refetchWorkspaces();
    refetchIssues();
  };

  const toggleWorkspaceRatcheting = async (workspaceId: string, enabled: boolean) => {
    setTogglingWorkspaceId(workspaceId);
    try {
      await toggleRatchetingMutation.mutateAsync({ workspaceId, enabled });
      await Promise.all([
        refetchWorkspaces(),
        utils.workspace.getProjectSummaryState.invalidate({ projectId }),
        utils.workspace.get.invalidate({ id: workspaceId }),
      ]);
    } finally {
      setTogglingWorkspaceId(null);
    }
  };

  const archiveWorkspace = async (workspaceId: string, commitUncommitted: boolean) => {
    setArchivingWorkspaceId(workspaceId);
    try {
      await archiveMutation.mutateAsync({ id: workspaceId, commitUncommitted });
      await refetchWorkspaces();
    } finally {
      setArchivingWorkspaceId(null);
    }
  };

  const refetch = () => {
    refetchWorkspaces();
    refetchIssues();
  };

  // Normalize issues from the active provider
  const normalizedIssues = useMemo(() => {
    if (isLinear) {
      return linearIssuesData?.issues?.map(normalizeLinearIssue);
    }
    return githubIssuesData?.issues?.map(normalizeGitHubIssue);
  }, [isLinear, githubIssuesData?.issues, linearIssuesData?.issues]);

  // Filter out issues that already have a workspace
  const filteredIssues = useMemo(() => {
    if (!normalizedIssues) {
      return undefined;
    }
    if (!workspaces) {
      return normalizedIssues;
    }

    if (isLinear) {
      const workspaceLinearIds = new Set(
        workspaces.map((w) => w.linearIssueId).filter((id): id is string => id !== null)
      );
      return normalizedIssues.filter(
        (issue) => !(issue.linearIssueId && workspaceLinearIds.has(issue.linearIssueId))
      );
    }

    const workspaceIssueNumbers = new Set(
      workspaces.map((w) => w.githubIssueNumber).filter((n): n is number => n !== null)
    );
    return normalizedIssues.filter(
      (issue) => !(issue.githubIssueNumber && workspaceIssueNumbers.has(issue.githubIssueNumber))
    );
  }, [normalizedIssues, workspaces, isLinear]);

  return (
    <KanbanContext.Provider
      value={{
        projectId,
        projectSlug,
        issueProvider,
        workspaces: workspaces as WorkspaceWithKanban[] | undefined,
        issues: filteredIssues,
        isLoading: isLoadingWorkspaces || isLoadingIssues,
        isError: isErrorWorkspaces,
        error: errorWorkspaces ? { message: errorWorkspaces.message } : null,
        refetch,
        syncAndRefetch,
        isSyncing: syncMutation.isPending,
        toggleWorkspaceRatcheting,
        togglingWorkspaceId,
        archiveWorkspace,
        archivingWorkspaceId,
        onCreateWorkspace,
        isCreatingWorkspace,
      }}
    >
      {children}
    </KanbanContext.Provider>
  );
}

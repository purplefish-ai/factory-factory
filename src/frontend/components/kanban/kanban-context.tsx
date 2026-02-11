import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import { trpc } from '@/frontend/lib/trpc';
import type { WorkspaceWithKanban } from './kanban-card';

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  state: 'OPEN' | 'CLOSED';
  createdAt: string;
  author: { login: string };
}

interface KanbanContextValue {
  projectId: string;
  projectSlug: string;
  workspaces: WorkspaceWithKanban[] | undefined;
  issues: GitHubIssue[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: { message: string } | null;
  refetch: () => void;
  syncAndRefetch: () => Promise<void>;
  isSyncing: boolean;
  toggleWorkspaceRatcheting: (workspaceId: string, enabled: boolean) => Promise<void>;
  togglingWorkspaceId: string | null;
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
  children: ReactNode;
}

export function KanbanProvider({ projectId, projectSlug, children }: KanbanProviderProps) {
  const utils = trpc.useUtils();
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

  const {
    data: issuesData,
    isLoading: isLoadingIssues,
    refetch: refetchIssues,
  } = trpc.github.listIssuesForProject.useQuery(
    { projectId },
    { refetchInterval: 60_000, staleTime: 30_000 }
  );

  const syncMutation = trpc.workspace.syncAllPRStatuses.useMutation();
  const toggleRatchetingMutation = trpc.workspace.toggleRatcheting.useMutation();
  const [togglingWorkspaceId, setTogglingWorkspaceId] = useState<string | null>(null);

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

  const refetch = () => {
    refetchWorkspaces();
    refetchIssues();
  };

  // Filter out issues that already have a workspace
  const filteredIssues = useMemo(() => {
    if (!issuesData?.issues) {
      return undefined;
    }
    if (!workspaces) {
      return issuesData.issues;
    }

    const workspaceIssueNumbers = new Set(
      workspaces.map((w) => w.githubIssueNumber).filter((n): n is number => n !== null)
    );

    return issuesData.issues.filter((issue) => !workspaceIssueNumbers.has(issue.number));
  }, [issuesData?.issues, workspaces]);

  return (
    <KanbanContext.Provider
      value={{
        projectId,
        projectSlug,
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
      }}
    >
      {children}
    </KanbanContext.Provider>
  );
}

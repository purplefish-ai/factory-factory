import { createContext, type ReactNode, useContext, useMemo } from 'react';
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
  const {
    data: workspaces,
    isLoading: isLoadingWorkspaces,
    isError: isErrorWorkspaces,
    error: errorWorkspaces,
    refetch: refetchWorkspaces,
  } = trpc.workspace.listWithKanbanState.useQuery(
    { projectId },
    { refetchInterval: 15_000, staleTime: 10_000 }
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

  const syncAndRefetch = async () => {
    await syncMutation.mutateAsync({ projectId });
    refetchWorkspaces();
    refetchIssues();
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
      }}
    >
      {children}
    </KanbanContext.Provider>
  );
}

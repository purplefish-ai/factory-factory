import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { trpc } from '@/frontend/lib/trpc';
import type { WorkspaceWithKanban } from './kanban-card';
import type { UIKanbanColumnId } from './kanban-column';

const STORAGE_KEY_PREFIX = 'kanban-hidden-columns-';
const SHOW_ARCHIVED_KEY_PREFIX = 'kanban-show-archived-';

function getHiddenColumnsFromStorage(projectId: string): UIKanbanColumnId[] {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const stored = localStorage.getItem(`${STORAGE_KEY_PREFIX}${projectId}`);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: Intentional error logging for debugging localStorage issues
    console.warn('Failed to parse hidden columns from localStorage:', error);
    return [];
  }
}

function saveHiddenColumnsToStorage(projectId: string, columns: UIKanbanColumnId[]) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${projectId}`, JSON.stringify(columns));
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: Intentional error logging for debugging localStorage issues
    console.warn('Failed to save hidden columns to localStorage:', error);
  }
}

function getShowArchivedFromStorage(projectId: string): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    const stored = localStorage.getItem(`${SHOW_ARCHIVED_KEY_PREFIX}${projectId}`);
    return stored === 'true';
  } catch {
    return false;
  }
}

function saveShowArchivedToStorage(projectId: string, value: boolean) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(`${SHOW_ARCHIVED_KEY_PREFIX}${projectId}`, String(value));
  } catch {
    // Ignore storage errors
  }
}

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
  hiddenColumns: UIKanbanColumnId[];
  toggleColumnVisibility: (columnId: UIKanbanColumnId) => void;
  showArchived: boolean;
  toggleShowArchived: () => void;
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
  const [hiddenColumns, setHiddenColumns] = useState<UIKanbanColumnId[]>([]);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    setHiddenColumns(getHiddenColumnsFromStorage(projectId));
    setShowArchived(getShowArchivedFromStorage(projectId));
  }, [projectId]);

  const {
    data: workspaces,
    isLoading: isLoadingWorkspaces,
    isError: isErrorWorkspaces,
    error: errorWorkspaces,
    refetch: refetchWorkspaces,
  } = trpc.workspace.listWithKanbanState.useQuery(
    { projectId, includeArchived: showArchived },
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

  const toggleColumnVisibility = (columnId: UIKanbanColumnId) => {
    setHiddenColumns((prev) => {
      const newHidden = prev.includes(columnId)
        ? prev.filter((id) => id !== columnId)
        : [...prev, columnId];
      saveHiddenColumnsToStorage(projectId, newHidden);
      return newHidden;
    });
  };

  const toggleShowArchived = () => {
    setShowArchived((prev) => {
      const newValue = !prev;
      saveShowArchivedToStorage(projectId, newValue);
      return newValue;
    });
  };

  return (
    <KanbanContext.Provider
      value={{
        projectId,
        projectSlug,
        workspaces: workspaces as WorkspaceWithKanban[] | undefined,
        issues: issuesData?.issues,
        isLoading: isLoadingWorkspaces || isLoadingIssues,
        isError: isErrorWorkspaces,
        error: errorWorkspaces ? { message: errorWorkspaces.message } : null,
        refetch,
        syncAndRefetch,
        isSyncing: syncMutation.isPending,
        hiddenColumns,
        toggleColumnVisibility,
        showArchived,
        toggleShowArchived,
      }}
    >
      {children}
    </KanbanContext.Provider>
  );
}

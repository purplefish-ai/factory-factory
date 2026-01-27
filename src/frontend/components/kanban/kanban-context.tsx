'use client';

import type { KanbanColumn as KanbanColumnType } from '@prisma-gen/browser';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { trpc } from '@/frontend/lib/trpc';
import type { WorkspaceWithKanban } from './kanban-card';

const STORAGE_KEY_PREFIX = 'kanban-hidden-columns-';

function getHiddenColumnsFromStorage(projectId: string): KanbanColumnType[] {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const stored = localStorage.getItem(`${STORAGE_KEY_PREFIX}${projectId}`);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveHiddenColumnsToStorage(projectId: string, columns: KanbanColumnType[]) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${projectId}`, JSON.stringify(columns));
  } catch {
    // Ignore errors
  }
}

interface KanbanContextValue {
  projectId: string;
  projectSlug: string;
  workspaces: WorkspaceWithKanban[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: { message: string } | null;
  refetch: () => void;
  hiddenColumns: KanbanColumnType[];
  toggleColumnVisibility: (columnId: KanbanColumnType) => void;
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
  const [hiddenColumns, setHiddenColumns] = useState<KanbanColumnType[]>([]);

  useEffect(() => {
    setHiddenColumns(getHiddenColumnsFromStorage(projectId));
  }, [projectId]);

  const {
    data: workspaces,
    isLoading,
    isError,
    error,
    refetch,
  } = trpc.workspace.listWithKanbanState.useQuery({ projectId }, { refetchInterval: 5000 });

  const toggleColumnVisibility = (columnId: KanbanColumnType) => {
    setHiddenColumns((prev) => {
      const newHidden = prev.includes(columnId)
        ? prev.filter((id) => id !== columnId)
        : [...prev, columnId];
      saveHiddenColumnsToStorage(projectId, newHidden);
      return newHidden;
    });
  };

  return (
    <KanbanContext.Provider
      value={{
        projectId,
        projectSlug,
        workspaces: workspaces as WorkspaceWithKanban[] | undefined,
        isLoading,
        isError,
        error: error ? { message: error.message } : null,
        refetch,
        hiddenColumns,
        toggleColumnVisibility,
      }}
    >
      {children}
    </KanbanContext.Provider>
  );
}

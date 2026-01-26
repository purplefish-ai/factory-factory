'use client';

import type { KanbanColumn as KanbanColumnType } from '@prisma-gen/browser';
import { RefreshCw, Settings } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/frontend/lib/trpc';
import type { WorkspaceWithKanban } from './kanban-card';
import { KANBAN_COLUMNS, KanbanColumn } from './kanban-column';

interface KanbanBoardProps {
  projectId: string;
  projectSlug: string;
}

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
    // Ignore errors (e.g., private browsing mode, storage full)
  }
}

export function KanbanBoard({ projectId, projectSlug }: KanbanBoardProps) {
  const [hiddenColumns, setHiddenColumns] = useState<KanbanColumnType[]>([]);

  // Load hidden columns from localStorage on mount
  useEffect(() => {
    setHiddenColumns(getHiddenColumnsFromStorage(projectId));
  }, [projectId]);

  const {
    data: workspaces,
    isLoading,
    isError,
    error,
    refetch,
    dataUpdatedAt,
  } = trpc.workspace.listWithKanbanState.useQuery({ projectId }, { refetchInterval: 5000 });

  // Group workspaces by kanban column
  const workspacesByColumn = useMemo(() => {
    const grouped: Record<KanbanColumnType, WorkspaceWithKanban[]> = {
      BACKLOG: [],
      IN_PROGRESS: [],
      WAITING: [],
      PR_OPEN: [],
      APPROVED: [],
      MERGED: [],
      DONE: [],
    };

    if (workspaces) {
      for (const workspace of workspaces) {
        grouped[workspace.kanbanColumn].push(workspace as WorkspaceWithKanban);
      }
    }

    return grouped;
  }, [workspaces]);

  const toggleColumnVisibility = (columnId: KanbanColumnType) => {
    setHiddenColumns((prev) => {
      const newHidden = prev.includes(columnId)
        ? prev.filter((id) => id !== columnId)
        : [...prev, columnId];
      saveHiddenColumnsToStorage(projectId, newHidden);
      return newHidden;
    });
  };

  // Calculate time since last update
  const timeSinceUpdate = dataUpdatedAt ? Math.round((Date.now() - dataUpdatedAt) / 1000) : null;
  const isStale = timeSinceUpdate !== null && timeSinceUpdate > 300; // 5 minutes

  if (isLoading) {
    return (
      <div className="flex gap-4 overflow-x-auto pb-4">
        {KANBAN_COLUMNS.map((column) => (
          <div key={column.id} className="min-w-[280px] space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-[200px] w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-destructive mb-4">
          Failed to load workspaces: {error?.message ?? 'Unknown error'}
        </p>
        <Button variant="outline" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Board Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {timeSinceUpdate !== null && (
            <span className={isStale ? 'text-yellow-600 dark:text-yellow-400' : ''}>
              Updated {timeSinceUpdate}s ago
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Settings className="h-4 w-4 mr-2" />
                Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel>Show Columns</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {KANBAN_COLUMNS.map((column) => (
                <div key={column.id} className="flex items-center gap-2 px-2 py-1.5">
                  <Checkbox
                    id={`col-${column.id}`}
                    checked={!hiddenColumns.includes(column.id)}
                    onCheckedChange={() => toggleColumnVisibility(column.id)}
                  />
                  <label htmlFor={`col-${column.id}`} className="text-sm cursor-pointer flex-1">
                    {column.label}
                  </label>
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Board Columns */}
      <ScrollArea className="w-full whitespace-nowrap">
        <div className="flex gap-4 pb-4">
          {KANBAN_COLUMNS.map((column) => (
            <KanbanColumn
              key={column.id}
              column={column}
              workspaces={workspacesByColumn[column.id]}
              projectSlug={projectSlug}
              isHidden={hiddenColumns.includes(column.id)}
            />
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}

'use client';

import type { KanbanColumn as KanbanColumnType } from '@prisma-gen/browser';
import { RefreshCw, Settings } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import type { WorkspaceWithKanban } from './kanban-card';
import { KANBAN_COLUMNS, KanbanColumn } from './kanban-column';
import { useKanban } from './kanban-context';

export function KanbanControls() {
  const { refetch, hiddenColumns, toggleColumnVisibility } = useKanban();

  return (
    <>
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
    </>
  );
}

export function KanbanBoard() {
  const { projectSlug, workspaces, isLoading, isError, error, refetch, hiddenColumns } =
    useKanban();

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
        grouped[workspace.kanbanColumn].push(workspace);
      }
    }

    return grouped;
  }, [workspaces]);

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
    <div className="flex gap-4 pb-4 h-full overflow-x-auto">
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
  );
}

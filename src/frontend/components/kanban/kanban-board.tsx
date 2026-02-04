import type { KanbanColumn as KanbanColumnType } from '@prisma-gen/browser';
import { Archive, RefreshCw, Settings } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import { IssueCard } from './issue-card';
import type { WorkspaceWithKanban } from './kanban-card';
import { KANBAN_COLUMNS, KanbanColumn } from './kanban-column';
import { type GitHubIssue, useKanban } from './kanban-context';

export function KanbanControls() {
  const {
    syncAndRefetch,
    isSyncing,
    hiddenColumns,
    toggleColumnVisibility,
    showArchived,
    toggleShowArchived,
  } = useKanban();

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => syncAndRefetch()} disabled={isSyncing}>
        <RefreshCw className={cn('h-4 w-4 mr-2', isSyncing && 'animate-spin')} />
        {isSyncing ? 'Syncing...' : 'Refresh'}
      </Button>

      <Button
        variant={showArchived ? 'secondary' : 'outline'}
        size="sm"
        onClick={toggleShowArchived}
      >
        <Archive className="h-4 w-4 mr-2" />
        {showArchived ? 'Hide Archived' : 'Show Archived'}
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
                className="mt-px"
              />
              <label
                htmlFor={`col-${column.id}`}
                className="text-sm leading-none cursor-pointer flex-1"
              >
                {column.label}
              </label>
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

interface WorkspacesByColumn {
  WORKING: WorkspaceWithKanban[];
  WAITING: WorkspaceWithKanban[];
  DONE: WorkspaceWithKanban[];
}

export function KanbanBoard() {
  const {
    projectId,
    projectSlug,
    workspaces,
    issues,
    isLoading,
    isError,
    error,
    refetch,
    hiddenColumns,
  } = useKanban();

  // Group workspaces by kanban column (only the 3 database columns)
  const workspacesByColumn = useMemo<WorkspacesByColumn>(() => {
    const grouped: WorkspacesByColumn = {
      WORKING: [],
      WAITING: [],
      DONE: [],
    };

    if (workspaces) {
      for (const workspace of workspaces) {
        const column = workspace.kanbanColumn as KanbanColumnType;
        if (column in grouped) {
          grouped[column].push(workspace);
        }
      }
    }

    return grouped;
  }, [workspaces]);

  if (isLoading) {
    return (
      <div className="flex gap-4 pb-4 h-full overflow-x-auto">
        {KANBAN_COLUMNS.map((column) => (
          <div key={column.id} className="flex flex-col h-full w-[280px] shrink-0">
            <Skeleton className="h-10 w-full rounded-t-lg rounded-b-none" />
            <Skeleton className="flex-1 w-full rounded-b-lg rounded-t-none" />
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
      {KANBAN_COLUMNS.map((column) => {
        if (hiddenColumns.includes(column.id)) {
          return null;
        }

        // Special handling for the ISSUES column (UI-only, not from database)
        if (column.id === 'ISSUES') {
          return (
            <IssuesColumn
              key={column.id}
              column={column}
              issues={issues ?? []}
              projectId={projectId}
              projectSlug={projectSlug}
            />
          );
        }

        // Regular workspace columns
        const columnWorkspaces = workspacesByColumn[column.id as KanbanColumnType] ?? [];
        return (
          <KanbanColumn
            key={column.id}
            column={column}
            workspaces={columnWorkspaces}
            projectSlug={projectSlug}
          />
        );
      })}
    </div>
  );
}

// Separate component for the Issues column
import { Badge } from '@/components/ui/badge';
import type { ColumnConfig } from './kanban-column';

interface IssuesColumnProps {
  column: ColumnConfig;
  issues: GitHubIssue[];
  projectId: string;
  projectSlug: string;
}

function IssuesColumn({ column, issues, projectId, projectSlug }: IssuesColumnProps) {
  const isEmpty = issues.length === 0;

  return (
    <div className="flex flex-col h-full w-[280px] shrink-0 overflow-hidden">
      {/* Column Header */}
      <div className="flex items-center justify-between px-2 py-3 bg-muted/30 rounded-t-lg">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-sm">{column.label}</h3>
          <Badge variant="secondary" className="h-5 min-w-5 justify-center text-xs">
            {issues.length}
          </Badge>
        </div>
      </div>

      {/* Column Content */}
      <div className="flex flex-col gap-2 flex-1 overflow-y-auto p-2 min-h-0 rounded-b-lg bg-muted/30">
        {isEmpty ? (
          <div className="flex items-center justify-center h-[150px] text-muted-foreground text-sm">
            {column.description}
          </div>
        ) : (
          issues.map((issue) => (
            <IssueCard
              key={issue.number}
              issue={issue}
              projectId={projectId}
              projectSlug={projectSlug}
            />
          ))
        )}
      </div>
    </div>
  );
}

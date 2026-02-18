import { RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { KanbanColumn as KanbanColumnType } from '@/shared/core';
import { IssueCard } from './issue-card';
import { IssueDetailsSheet } from './issue-details-sheet';
import type { WorkspaceWithKanban } from './kanban-card';
import { type ColumnConfig, getKanbanColumns, KanbanColumn } from './kanban-column';
import { type KanbanIssue, useKanban } from './kanban-context';

export function KanbanControls() {
  const { syncAndRefetch, isSyncing } = useKanban();

  return (
    <Button
      variant="outline"
      size="icon"
      className="h-8 w-8"
      onClick={() => syncAndRefetch()}
      disabled={isSyncing}
    >
      <RefreshCw className={cn('h-4 w-4', isSyncing && 'animate-spin')} />
    </Button>
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
    issueProvider,
    workspaces,
    issues,
    isLoading,
    isError,
    error,
    refetch,
    toggleWorkspaceRatcheting,
    togglingWorkspaceId,
  } = useKanban();

  const columns = useMemo(() => getKanbanColumns(issueProvider), [issueProvider]);

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
      <div className="flex flex-col md:flex-row gap-3 md:gap-4 pb-4 h-full overflow-y-auto md:overflow-y-hidden md:overflow-x-auto">
        {columns.map((column) => (
          <div key={column.id} className="flex flex-col w-full md:w-[380px] md:shrink-0 md:h-full">
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
    <div className="flex flex-col md:flex-row gap-3 md:gap-4 pb-4 h-full overflow-y-auto md:overflow-y-hidden md:overflow-x-auto">
      {columns.map((column) => {
        // Special handling for the ISSUES column (UI-only, not from database)
        if (column.id === 'ISSUES') {
          return (
            <IssuesColumn
              key={column.id}
              column={column}
              issues={issues ?? []}
              projectId={projectId}
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
            onToggleRatcheting={toggleWorkspaceRatcheting}
            togglingWorkspaceId={togglingWorkspaceId}
          />
        );
      })}
    </div>
  );
}

// Separate component for the Issues column
interface IssuesColumnProps {
  column: ColumnConfig;
  issues: KanbanIssue[];
  projectId: string;
}

function IssuesColumn({ column, issues, projectId }: IssuesColumnProps) {
  const isEmpty = issues.length === 0;
  const [selectedIssue, setSelectedIssue] = useState<KanbanIssue | null>(null);
  const [isSheetOpen, setIsSheetOpen] = useState(false);

  const handleIssueClick = (issue: KanbanIssue) => {
    setSelectedIssue(issue);
    setIsSheetOpen(true);
  };

  const handleSheetOpenChange = (open: boolean) => {
    setIsSheetOpen(open);
    if (!open) {
      // Clear selected issue when sheet closes
      setSelectedIssue(null);
    }
  };

  return (
    <>
      <div className="flex flex-col w-full md:w-[380px] md:shrink-0 md:h-full">
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
        <div className="flex flex-col gap-3 flex-1 overflow-y-auto p-3 min-h-0 rounded-b-lg bg-muted/30">
          {isEmpty ? (
            <div className="flex items-center justify-center h-[60px] md:h-[150px] text-muted-foreground text-sm">
              {column.description}
            </div>
          ) : (
            issues.map((issue) => (
              <div key={issue.id} className="shrink-0">
                <IssueCard
                  issue={issue}
                  projectId={projectId}
                  onClick={() => handleIssueClick(issue)}
                />
              </div>
            ))
          )}
        </div>
      </div>

      <IssueDetailsSheet
        issue={selectedIssue}
        projectId={projectId}
        open={isSheetOpen}
        onOpenChange={handleSheetOpenChange}
      />
    </>
  );
}

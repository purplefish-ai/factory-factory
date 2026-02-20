import { Plus, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ArchiveWorkspaceDialog } from '@/components/workspace';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import type { KanbanColumn as KanbanColumnType } from '@/shared/core';
import { InlineWorkspaceForm } from './inline-workspace-form';
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
      size="sm"
      className="h-8"
      onClick={() => syncAndRefetch()}
      disabled={isSyncing}
    >
      <RefreshCw className={cn('h-4 w-4', isSyncing && 'animate-spin')} />
      Refresh
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
    archiveWorkspace,
    bulkArchiveColumn,
    isBulkArchiving,
    showInlineForm,
    setShowInlineForm,
  } = useKanban();

  const isMobile = useIsMobile();
  const columns = useMemo(() => getKanbanColumns(issueProvider), [issueProvider]);
  const [activeColumnId, setActiveColumnId] = useState<string>('WAITING');
  const hasPickedInitialTab = useRef(false);
  const [bulkArchiveDialogOpen, setBulkArchiveDialogOpen] = useState(false);
  const [bulkArchiveColumnId, setBulkArchiveColumnId] = useState<string | null>(null);

  const handleMobileNewTaskClick = () => {
    setActiveColumnId('ISSUES');
    setShowInlineForm(true);
  };

  const handleBulkArchive = (columnId: string) => {
    setBulkArchiveColumnId(columnId);
    setBulkArchiveDialogOpen(true);
  };

  const handleBulkArchiveConfirm = async (commitUncommitted: boolean) => {
    if (bulkArchiveColumnId) {
      await bulkArchiveColumn(bulkArchiveColumnId, commitUncommitted);
    }
  };

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

  // Switch to ISSUES tab when inline form is opened from mobile.
  useEffect(() => {
    if (showInlineForm && isMobile) {
      setActiveColumnId('ISSUES');
    }
  }, [showInlineForm, isMobile]);

  // Pick the initial mobile tab once data loads
  useEffect(() => {
    if (hasPickedInitialTab.current || !workspaces) {
      return;
    }
    hasPickedInitialTab.current = true;

    if (workspacesByColumn.WAITING.length > 0) {
      setActiveColumnId('WAITING');
    } else if (workspacesByColumn.WORKING.length > 0) {
      setActiveColumnId('WORKING');
    } else {
      setActiveColumnId('ISSUES');
    }
  }, [workspaces, workspacesByColumn]);

  const getColumnCount = (columnId: string) => {
    if (columnId === 'ISSUES') {
      return issues?.length ?? 0;
    }
    return workspacesByColumn[columnId as KanbanColumnType]?.length ?? 0;
  };

  if (isLoading) {
    return (
      <div className="flex flex-col md:flex-row gap-3 md:gap-4 pb-4 h-full overflow-y-auto md:overflow-y-hidden md:overflow-x-auto mx-auto w-full max-w-[1800px]">
        {columns.map((column) => (
          <div
            key={column.id}
            className="flex flex-col w-full md:flex-1 md:min-w-[280px] md:max-w-[440px] md:h-full"
          >
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

  if (isMobile) {
    const activeColumn = columns.find((c) => c.id === activeColumnId) ?? columns[0];
    if (!activeColumn) {
      return null;
    }

    return (
      <div className="flex flex-col h-full gap-3">
        {/* Column pills */}
        <div className="flex gap-1.5 shrink-0">
          {columns.map((column) => {
            const count = getColumnCount(column.id);
            const isActive = column.id === activeColumnId;
            return (
              <button
                key={column.id}
                type="button"
                onClick={() => setActiveColumnId(column.id)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                )}
              >
                {column.shortLabel ?? column.label}
                <span
                  className={cn(
                    'inline-flex items-center justify-center rounded-full min-w-4 h-4 px-1 text-[10px] font-semibold',
                    isActive ? 'bg-primary-foreground/20' : 'bg-background/50'
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 w-full"
          onClick={handleMobileNewTaskClick}
        >
          <Plus className="h-4 w-4" />
          New Task
        </Button>

        {/* Active column content */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {activeColumn.id === 'ISSUES' ? (
            <IssuesColumn column={activeColumn} issues={issues ?? []} projectId={projectId} />
          ) : (
            <KanbanColumn
              column={activeColumn}
              workspaces={workspacesByColumn[activeColumn.id as KanbanColumnType] ?? []}
              projectSlug={projectSlug}
              onToggleRatcheting={toggleWorkspaceRatcheting}
              togglingWorkspaceId={togglingWorkspaceId}
              onArchive={archiveWorkspace}
              onBulkArchive={() => handleBulkArchive(activeColumn.id)}
              isBulkArchiving={isBulkArchiving}
            />
          )}
        </div>
      </div>
    );
  }

  const workspacesInBulkArchiveColumn =
    bulkArchiveColumnId && bulkArchiveColumnId !== 'ISSUES'
      ? (workspacesByColumn[bulkArchiveColumnId as KanbanColumnType] ?? [])
      : [];

  return (
    <>
      <div className="flex flex-row gap-4 pb-4 h-full overflow-y-hidden overflow-x-auto mx-auto w-full max-w-[1800px]">
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
              onArchive={archiveWorkspace}
              onBulkArchive={() => handleBulkArchive(column.id)}
              isBulkArchiving={isBulkArchiving}
            />
          );
        })}
      </div>

      <ArchiveWorkspaceDialog
        open={bulkArchiveDialogOpen}
        onOpenChange={setBulkArchiveDialogOpen}
        hasUncommitted={true}
        onConfirm={handleBulkArchiveConfirm}
        description={`This will archive all ${workspacesInBulkArchiveColumn.length} workspace(s) in this column. Archiving will remove the workspace worktrees from disk.`}
        warningText="Warning: Some workspaces may have uncommitted changes and they will be committed before archiving."
        checkboxLabel="Commit uncommitted changes before archiving"
      />
    </>
  );
}

// Separate component for the Issues column
interface IssuesColumnProps {
  column: ColumnConfig;
  issues: KanbanIssue[];
  projectId: string;
}

function IssuesColumn({ column, issues, projectId }: IssuesColumnProps) {
  const { workspaces, showInlineForm, setShowInlineForm } = useKanban();
  const isMobile = useIsMobile();
  const existingNames = useMemo(() => workspaces?.map((w) => w.name) ?? [], [workspaces]);
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
      <div className="flex flex-col w-full md:flex-1 md:min-w-[280px] md:max-w-[440px] md:h-full">
        {/* Column Header — hidden on mobile where pills handle this */}
        <div className="hidden md:flex items-center justify-between px-2 py-3 bg-muted/50 rounded-t-lg">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-sm">{column.label}</h3>
            <Badge variant="secondary" className="h-5 min-w-5 justify-center text-xs">
              {issues.length}
            </Badge>
          </div>
        </div>

        {/* Column Content */}
        <div className="flex flex-col gap-3 flex-1 overflow-y-auto p-3 min-h-0 rounded-lg md:rounded-t-none bg-muted/50">
          {showInlineForm ? (
            <InlineWorkspaceForm
              projectId={projectId}
              existingNames={existingNames}
              onCancel={() => setShowInlineForm(false)}
              onCreated={() => setShowInlineForm(false)}
            />
          ) : !isMobile ? (
            <button
              type="button"
              onClick={() => setShowInlineForm(true)}
              className="shrink-0 flex items-center gap-2 rounded-lg border border-dashed border-primary/40 px-3 py-5 text-sm text-primary hover:border-primary/70 hover:text-primary transition-colors cursor-pointer"
            >
              <Plus className="h-4 w-4" />
              New Workspace
            </button>
          ) : null}
          {!isEmpty &&
            issues.map((issue) => (
              <div key={issue.id} className="shrink-0">
                <IssueCard
                  issue={issue}
                  projectId={projectId}
                  onClick={() => handleIssueClick(issue)}
                />
              </div>
            ))}
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

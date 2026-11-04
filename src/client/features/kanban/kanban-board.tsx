import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArchiveGitLockDialog, ArchiveWorkspaceDialog } from '@/client/features/workspace';
import { useStableCallback } from '@/client/hooks/use-stable-callback';
import { runInBackground } from '@/client/lib/background-task';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import type { KanbanColumn as KanbanColumnType } from '@/shared/core';
import { type BoardSort, filterBoardWorkspaces, sortBoardWorkspaces } from './board-view';
import { BoardViewControls } from './board-view-controls';
import { IssuesColumn } from './issues-column';
import type { WorkspaceWithKanban } from './kanban-card';
import { getKanbanColumns, KanbanColumn } from './kanban-column';
import { useKanban } from './kanban-context';
import { KanbanFamilyProvider } from './kanban-family-highlight';
import { QuickChatSheet } from './quick-chat-sheet';

interface WorkspacesByColumn {
  WORKING: WorkspaceWithKanban[];
  WAITING: WorkspaceWithKanban[];
  DONE: WorkspaceWithKanban[];
}

const EMPTY_WORKSPACES: WorkspaceWithKanban[] = [];

export function KanbanBoard() {
  const { workspaces, projectId } = useKanban();
  return (
    <KanbanFamilyProvider key={projectId} workspaces={workspaces ?? EMPTY_WORKSPACES}>
      <KanbanBoardContent />
    </KanbanFamilyProvider>
  );
}

/**
 * The first mobile tab once data loads. A New Workspace request made while the
 * board was still loading keeps the form's Todo tab instead of being replaced.
 */
function pickInitialMobileColumn(
  workspacesByColumn: WorkspacesByColumn,
  showInlineForm: boolean
): string {
  if (showInlineForm) {
    return 'ISSUES';
  }
  if (workspacesByColumn.WAITING.length > 0) {
    return 'WAITING';
  }
  return workspacesByColumn.WORKING.length > 0 ? 'WORKING' : 'ISSUES';
}

/**
 * On mobile the inline form lives in the Todo tab. Switch to it when the form
 * opens, and again on every header "New Workspace" request: the button can be
 * pressed while the form is already open behind another tab.
 */
function useRevealMobileInlineForm({
  isMobile,
  showInlineForm,
  inlineFormRequest,
  setActiveColumnId,
}: {
  isMobile: boolean;
  showInlineForm: boolean;
  inlineFormRequest: number;
  setActiveColumnId: (columnId: string) => void;
}) {
  useEffect(() => {
    if (showInlineForm && isMobile) {
      setActiveColumnId('ISSUES');
    }
  }, [showInlineForm, isMobile, setActiveColumnId]);

  const [seenInlineFormRequest, setSeenInlineFormRequest] = useState(inlineFormRequest);
  if (seenInlineFormRequest !== inlineFormRequest) {
    setSeenInlineFormRequest(inlineFormRequest);
    if (isMobile) {
      setActiveColumnId('ISSUES');
    }
  }
}

function KanbanBoardContent() {
  const {
    unreadMailCounts,
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
    renameWorkspace,
    archiveWorkspace,
    archiveSelectedWorkspaces,
    bulkArchiveColumn,
    archiveGitLockWorkspaceIds,
    dismissArchiveGitLock,
    retryGitLockedArchives,
    isBulkArchiving,
    isArchiving,
    requestInlineForm,
    showInlineForm,
    inlineFormRequest,
    quickChatWorkspaceId,
    openQuickChat,
    closeQuickChat,
  } = useKanban();

  // Context commands are recreated on every render. Stable wrappers let the
  // memoized cards skip re-rendering when another workspace changes.
  const handleToggleRatcheting = useStableCallback((workspaceId: string, enabled: boolean) => {
    runInBackground(toggleWorkspaceRatcheting(workspaceId, enabled), "Couldn't update workspace.");
  });
  const handleArchiveWorkspace = useStableCallback((workspaceId: string) => {
    runInBackground(archiveWorkspace(workspaceId), "Couldn't archive workspace.");
  });
  const handleRenameWorkspace = useStableCallback(renameWorkspace);
  const handleGitLockOpenChange = useStableCallback((open: boolean) => {
    if (!open) {
      dismissArchiveGitLock();
    }
  });
  const handleRetryGitLockedArchives = useStableCallback(() => {
    void retryGitLockedArchives(false);
  });
  const handleRemoveGitLocksAndArchive = useStableCallback(() => {
    void retryGitLockedArchives(true);
  });

  const isMobile = useIsMobile();
  const columns = useMemo(() => getKanbanColumns(issueProvider), [issueProvider]);
  const [activeColumnId, setActiveColumnId] = useState<string>('WAITING');
  const hasPickedInitialTab = useRef(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<BoardSort>('default');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isSelectionArchiving, setIsSelectionArchiving] = useState(false);
  const [selectionDialogOpen, setSelectionDialogOpen] = useState(false);
  const toggleSelected = (id: string) =>
    setSelectedIds((ids) =>
      ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]
    );
  const archiveSelected = async () => {
    setIsSelectionArchiving(true);
    try {
      setSelectedIds(await archiveSelectedWorkspaces(selectedIds));
    } finally {
      setIsSelectionArchiving(false);
    }
  };
  useEffect(() => {
    if (!isSelectionArchiving) {
      setSelectedIds((ids) =>
        ids.filter((id) => workspaces?.some((workspace) => workspace.id === id))
      );
    }
  }, [workspaces, isSelectionArchiving]);
  const [bulkArchiveDialogOpen, setBulkArchiveDialogOpen] = useState(false);
  const [bulkArchiveColumnId, setBulkArchiveColumnId] = useState<string | null>(null);

  const handleBulkArchive = (columnId: string) => {
    setBulkArchiveColumnId(columnId);
    setBulkArchiveDialogOpen(true);
  };

  const handleBulkArchiveConfirm = async () => {
    if (bulkArchiveColumnId) {
      await bulkArchiveColumn(bulkArchiveColumnId);
    }
  };

  // Keep snapshot order untouched; filtering and sorting affect this view only.
  const workspacesByColumn = useMemo<WorkspacesByColumn>(() => {
    const grouped: WorkspacesByColumn = {
      WORKING: [],
      WAITING: [],
      DONE: [],
    };

    if (workspaces) {
      for (const workspace of filterBoardWorkspaces(workspaces, search)) {
        const column = workspace.kanbanColumn as KanbanColumnType;
        if (column in grouped) {
          grouped[column].push(workspace);
        }
      }
    }

    for (const column of Object.keys(grouped) as KanbanColumnType[]) {
      grouped[column] = sortBoardWorkspaces(grouped[column], sort);
    }

    return grouped;
  }, [workspaces, search, sort]);

  useRevealMobileInlineForm({ isMobile, showInlineForm, inlineFormRequest, setActiveColumnId });

  // Pick the initial mobile tab once data loads
  useEffect(() => {
    if (hasPickedInitialTab.current || !workspaces) {
      return;
    }
    hasPickedInitialTab.current = true;
    setActiveColumnId(pickInitialMobileColumn(workspacesByColumn, showInlineForm));
  }, [workspaces, workspacesByColumn, showInlineForm]);

  const visibleIssues = (issues ?? []).filter((issue) =>
    `${issue.title} ${issue.displayId}`
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase())
  );
  const getColumnCount = (columnId: string) => {
    if (columnId === 'ISSUES') {
      return visibleIssues.length;
    }
    return workspacesByColumn[columnId as KanbanColumnType]?.length ?? 0;
  };

  const archiveGitLockDialog = (
    <ArchiveGitLockDialog
      open={archiveGitLockWorkspaceIds.length > 0}
      onOpenChange={handleGitLockOpenChange}
      workspaceCount={archiveGitLockWorkspaceIds.length}
      onRetry={handleRetryGitLockedArchives}
      onRemoveLockAndArchive={handleRemoveGitLocksAndArchive}
    />
  );

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
          Couldn't load workspaces. {error?.message ?? 'Unknown error'}
        </p>
        <Button variant="outline" onClick={() => refetch()}>
          <ArrowsClockwiseIcon className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  const renderColumn = (column: (typeof columns)[number]) =>
    column.id === 'ISSUES' ? (
      <IssuesColumn
        key={column.id}
        column={column}
        issues={visibleIssues}
        filtered={search.trim().length > 0}
        projectId={projectId}
        onWorkspaceCreated={() => setActiveColumnId('WORKING')}
      />
    ) : (
      <KanbanColumn
        key={column.id}
        column={column}
        workspaces={workspacesByColumn[column.id] ?? []}
        projectSlug={projectSlug}
        unreadMailCounts={unreadMailCounts}
        onToggleRatcheting={handleToggleRatcheting}
        togglingWorkspaceId={togglingWorkspaceId}
        onArchive={handleArchiveWorkspace}
        onBulkArchive={() => handleBulkArchive(column.id)}
        isBulkArchiving={isBulkArchiving || isSelectionArchiving}
        onOpenQuickChat={openQuickChat}
        onRename={handleRenameWorkspace}
        selectedIds={selectedIds}
        onToggleSelected={toggleSelected}
        selectionDisabled={isSelectionArchiving}
      />
    );
  const columnArchiveCount = bulkArchiveColumnId
    ? (workspaces ?? []).filter((workspace) => workspace.kanbanColumn === bulkArchiveColumnId)
        .length
    : 0;
  return (
    <div className="flex flex-col h-full min-h-0 gap-3">
      {workspaces?.length === 0 && !showInlineForm && !isArchiving && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-4">
          <div>
            <p className="font-medium">Create your first workspace</p>
            <p className="text-sm text-muted-foreground">
              Start from an issue in Todo or describe a new task.
            </p>
          </div>
          <Button size="sm" onClick={requestInlineForm}>
            New workspace
          </Button>
        </div>
      )}
      <BoardViewControls
        search={search}
        onSearchChange={setSearch}
        sort={sort}
        onSortChange={setSort}
        selectedCount={selectedIds.length}
        isArchiving={isSelectionArchiving || isBulkArchiving}
        onArchive={() => setSelectionDialogOpen(true)}
        onClear={() => setSelectedIds([])}
      />
      {search &&
        Object.values(workspacesByColumn).every((rows) => rows.length === 0) &&
        visibleIssues.length === 0 && (
          <p className="text-sm text-muted-foreground">No matching issues or workspaces</p>
        )}
      {isMobile ? (
        <>
          <div className="flex gap-1.5 shrink-0">
            {columns.map((column) => (
              <button
                key={column.id}
                type="button"
                onClick={() => setActiveColumnId(column.id)}
                aria-pressed={column.id === activeColumnId}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1 rounded-full px-2 py-1.5 text-xs font-medium',
                  column.id === activeColumnId
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                {column.shortLabel ?? column.label}
                <span>{getColumnCount(column.id)}</span>
              </button>
            ))}
          </div>
          <div key={activeColumnId} className="flex-1 min-h-0 overflow-y-auto">
            {columns.filter((column) => column.id === activeColumnId).map(renderColumn)}
          </div>
        </>
      ) : (
        <div className="flex flex-row gap-4 pb-4 flex-1 min-h-0 overflow-y-hidden overflow-x-auto mx-auto w-full max-w-[1800px]">
          {columns.map(renderColumn)}
        </div>
      )}
      <ArchiveWorkspaceDialog
        open={bulkArchiveDialogOpen}
        onOpenChange={setBulkArchiveDialogOpen}
        onConfirm={() =>
          runInBackground(handleBulkArchiveConfirm(), "Couldn't archive workspaces.")
        }
        description={`This will archive all ${columnArchiveCount} ${columnArchiveCount === 1 ? 'workspace' : 'workspaces'} in this column, including any hidden by filters. Uncommitted changes will be committed before the worktrees are removed. Chat history and branches are kept. Worktree removal cannot be undone in the app.`}
      />
      <ArchiveWorkspaceDialog
        open={selectionDialogOpen}
        onOpenChange={setSelectionDialogOpen}
        onConfirm={() => runInBackground(archiveSelected(), "Couldn't archive workspaces.")}
        description={`Archive ${selectedIds.length} selected ${selectedIds.length === 1 ? 'workspace' : 'workspaces'}? Uncommitted changes will be committed before the worktrees are removed. Chat history and branches are kept. Worktree removal cannot be undone in the app. Failed archives remain selected for retry.`}
      />
      {archiveGitLockDialog}
      <QuickChatSheet workspaceId={quickChatWorkspaceId} onClose={closeQuickChat} />
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from '@/client/components/empty-state';
import { QueryErrorState, QueryRefreshError } from '@/client/components/query-error-state';
import { ArchiveGitLockDialog } from '@/client/features/workspace';
import { useStableCallback } from '@/client/hooks/use-stable-callback';
import { runInBackground } from '@/client/lib/background-task';
import { Skeleton } from '@/components/ui/skeleton';
import { useIsMobile } from '@/hooks/use-mobile';
import type { KanbanColumn as KanbanColumnType } from '@/shared/core';
import { ArchiveSelectionDialog } from './archive-selection-dialog';
import {
  type BoardSelection,
  columnSelectionState,
  EMPTY_BOARD_SELECTION,
  selectedBoardIds,
  toggleBoardSelection,
  toggleColumnSelection,
} from './board-selection';
import { BoardSelectionBar } from './board-selection-bar';
import { filterBoardWorkspaces, sortBoardWorkspaces } from './board-view';
import { BoardViewControls } from './board-view-controls';
import { IssuesColumn } from './issues-column';
import type { WorkspaceWithKanban } from './kanban-card';
import { getKanbanColumns, KanbanColumn } from './kanban-column';
import { useKanban } from './kanban-context';
import { KanbanFamilyProvider } from './kanban-family-highlight';
import { LazyQuickChatSheet } from './lazy-quick-chat-sheet';
import { MobileBoardSections } from './mobile-board-sections';
import { useWaitingSortOrder } from './use-waiting-sort-order';

interface WorkspacesByColumn {
  WORKING: WorkspaceWithKanban[];
  WAITING: WorkspaceWithKanban[];
  DONE: WorkspaceWithKanban[];
}

const EMPTY_WORKSPACES: WorkspaceWithKanban[] = [];
const SELECTABLE_COLUMNS = ['WORKING', 'WAITING', 'DONE'] as const;

interface ArchiveTarget {
  source: 'column' | 'selection';
  workspaces: WorkspaceWithKanban[];
  scope?: string;
}

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

export function KanbanBoard() {
  const { workspaces, projectId } = useKanban();
  return (
    <KanbanFamilyProvider key={projectId} workspaces={workspaces ?? EMPTY_WORKSPACES}>
      <KanbanBoardContent />
    </KanbanFamilyProvider>
  );
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
    error,
    isFetching,
    refetch,
    toggleWorkspaceRatcheting,
    togglingWorkspaceIds,
    renameWorkspace,
    archiveWorkspace,
    archiveWorkspaces,
    isSelecting,
    stopSelecting,
    archiveGitLockWorkspaceIds,
    dismissArchiveGitLock,
    retryGitLockedArchives,
    isBulkArchiving,
    isArchiving,
    showInlineForm,
    inlineFormRequest,
    quickChatWorkspaceId,
    openQuickChat,
    closeQuickChat,
  } = useKanban();

  // Cards take a fire-and-forget archive; the command itself resolves for the git-lock retry.
  const handleArchiveWorkspace = useCallback(
    (workspaceId: string) =>
      runInBackground(archiveWorkspace(workspaceId), "Couldn't archive workspace."),
    [archiveWorkspace]
  );
  // The lock dialog is memoized; these follow the provider's stable commands.
  const handleLockOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        dismissArchiveGitLock();
      }
    },
    [dismissArchiveGitLock]
  );
  const handleLockRetry = useCallback(
    () => void retryGitLockedArchives(false),
    [retryGitLockedArchives]
  );
  const handleLockRemoveAndArchive = useCallback(
    () => void retryGitLockedArchives(true),
    [retryGitLockedArchives]
  );

  const isMobile = useIsMobile();
  const columns = useMemo(() => getKanbanColumns(issueProvider), [issueProvider]);
  const [workspaceCreationRequest, setWorkspaceCreationRequest] = useState(0);
  const [search, setSearch] = useState('');
  const [waitingSortOrder, setWaitingSortOrder] = useWaitingSortOrder();
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  // Captured when the dialog opens, so confirming archives exactly what it listed.
  const [archiveTarget, setArchiveTarget] = useState<ArchiveTarget | null>(null);

  const handleBulkArchive = (columnId: string) => {
    const column = columns.find((candidate) => candidate.id === columnId);
    setArchiveTarget({
      source: 'column',
      // The unfiltered list: Archive All includes cards the filter hides.
      workspaces: (workspaces ?? []).filter((workspace) => workspace.kanbanColumn === columnId),
      scope: `This archives every workspace in ${column?.label ?? 'this column'}, including any hidden by filters.`,
    });
    setArchiveDialogOpen(true);
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
      grouped[column] = sortBoardWorkspaces(grouped[column], waitingSortOrder);
    }

    return grouped;
  }, [workspaces, search, waitingSortOrder]);

  const [selection, setSelection] = useState<BoardSelection>(EMPTY_BOARD_SELECTION);
  const [selectionFor, setSelectionFor] = useState(isSelecting);
  if (selectionFor !== isSelecting) {
    // Entering or leaving selection mode starts from nothing selected.
    setSelectionFor(isSelecting);
    setSelection(EMPTY_BOARD_SELECTION);
  }
  const [selectionArchives, setSelectionArchives] = useState(0);
  // Changes whenever selection mode starts or stops, so a late archive result
  // cannot end a later selection.
  const selectionSession = useRef(0);
  const boardRef = useRef<HTMLDivElement>(null);
  const cancelSelectionRef = useRef<HTMLButtonElement>(null);
  const archiveSelectionRef = useRef<HTMLButtonElement>(null);
  // Only cards on the board count: hidden or archived cards stay out of the
  // count and the archive, even if they were selected earlier.
  const selectedIds = selectedBoardIds(
    selection,
    SELECTABLE_COLUMNS.flatMap((column) => workspacesByColumn[column].map(({ id }) => id))
  );

  const toggleSelected = useStableCallback((workspaceId: string, range: boolean) => {
    const column = SELECTABLE_COLUMNS.find((candidate) =>
      workspacesByColumn[candidate].some(({ id }) => id === workspaceId)
    );
    const columnIds = column ? workspacesByColumn[column].map(({ id }) => id) : [];
    setSelection((current) => toggleBoardSelection(current, columnIds, workspaceId, range));
  });

  useEffect(() => {
    selectionSession.current += 1;
    if (!isSelecting) {
      return;
    }
    // After the menu that started the mode has closed and released focus.
    const timer = setTimeout(() => {
      const firstCheckbox = boardRef.current?.querySelector<HTMLElement>(
        '[data-board-selection-checkbox]'
      );
      (firstCheckbox ?? cancelSelectionRef.current)?.focus();
    });
    return () => clearTimeout(timer);
  }, [isSelecting]);

  useEffect(() => {
    if (!(isSelecting && !archiveDialogOpen)) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      // A dialog or menu that handles Escape marks it handled first.
      if (event.key === 'Escape' && !event.defaultPrevented && !isEditableTarget(event.target)) {
        stopSelecting();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isSelecting, archiveDialogOpen, stopSelecting]);

  const handleArchiveSelection = () => {
    const ids = new Set(selectedIds);
    setArchiveTarget({
      source: 'selection',
      workspaces: (workspaces ?? []).filter((workspace) => ids.has(workspace.id)),
    });
    setArchiveDialogOpen(true);
  };

  const archiveSelection = async (ids: string[]) => {
    const session = selectionSession.current;
    setSelectionArchives((count) => count + 1);
    try {
      const { failedIds } = await archiveWorkspaces(ids);
      // Failed cards come back still selected, so the user can retry or deselect them.
      if (failedIds.length === 0 && session === selectionSession.current) {
        stopSelecting();
      }
    } finally {
      setSelectionArchives((count) => count - 1);
    }
  };

  const handleArchiveDialogOpenChange = (open: boolean) => {
    setArchiveDialogOpen(open);
    if (open || archiveTarget?.source !== 'selection') {
      return;
    }
    // The dialog has no trigger to return focus to; give it back to the bar.
    // Archive is disabled while an archive runs, so Cancel takes it then.
    setTimeout(() => {
      const archive = archiveSelectionRef.current;
      (archive && !archive.disabled ? archive : cancelSelectionRef.current)?.focus();
    });
  };

  const handleArchiveConfirm = () => {
    if (!archiveTarget) {
      return;
    }
    const ids = archiveTarget.workspaces.map((workspace) => workspace.id);
    runInBackground(
      archiveTarget.source === 'selection' ? archiveSelection(ids) : archiveWorkspaces(ids),
      "Couldn't archive workspaces."
    );
  };

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
      onOpenChange={handleLockOpenChange}
      workspaceCount={archiveGitLockWorkspaceIds.length}
      onRetry={handleLockRetry}
      onRemoveLockAndArchive={handleLockRemoveAndArchive}
      isPending={isArchiving}
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

  // A failed refresh keeps the cached board, so open forms and scroll survive.
  if (error && !workspaces) {
    return (
      <QueryErrorState
        title="Couldn't load workspaces"
        error={error}
        onRetry={refetch}
        isRetrying={isFetching}
        className="py-12"
      />
    );
  }

  const columnSelection = (columnId: KanbanColumnType) => {
    const columnIds = workspacesByColumn[columnId].map(({ id }) => id);
    return {
      selectedIds: selection.selectedIds,
      state: columnSelectionState(selection, columnIds),
      onToggle: toggleSelected,
      onToggleAll: () => setSelection((current) => toggleColumnSelection(current, columnIds)),
    };
  };
  const renderColumn = (column: (typeof columns)[number]) =>
    column.id === 'ISSUES' ? (
      <IssuesColumn
        key={column.id}
        column={column}
        issues={visibleIssues}
        filtered={search.trim().length > 0}
        projectId={projectId}
        onWorkspaceCreated={() => {
          setSearch('');
          setWorkspaceCreationRequest((request) => request + 1);
        }}
      />
    ) : (
      <KanbanColumn
        key={column.id}
        column={column}
        workspaces={workspacesByColumn[column.id] ?? []}
        projectSlug={projectSlug}
        waitingSortOrder={waitingSortOrder}
        onWaitingSortOrderChange={setWaitingSortOrder}
        unreadMailCounts={unreadMailCounts}
        onToggleRatcheting={toggleWorkspaceRatcheting}
        togglingWorkspaceIds={togglingWorkspaceIds}
        onArchive={handleArchiveWorkspace}
        onBulkArchive={() => handleBulkArchive(column.id)}
        isBulkArchiving={isBulkArchiving}
        onOpenQuickChat={openQuickChat}
        onRename={renameWorkspace}
        selection={isSelecting ? columnSelection(column.id) : undefined}
      />
    );
  return (
    <div ref={boardRef} className="flex flex-col h-full min-h-0 gap-3">
      {error ? (
        <QueryRefreshError
          title="Couldn't refresh workspaces"
          error={error}
          onRetry={refetch}
          isRetrying={isFetching}
          className="rounded-md border"
        />
      ) : null}
      <BoardViewControls search={search} onSearchChange={setSearch} />
      {search &&
        Object.values(workspacesByColumn).every((rows) => rows.length === 0) &&
        visibleIssues.length === 0 && (
          <EmptyState size="compact" title="No matching issues or workspaces" />
        )}
      {isMobile ? (
        <MobileBoardSections
          sections={columns.map((column) => ({
            column,
            count: getColumnCount(column.id),
            visible:
              !search.trim() ||
              getColumnCount(column.id) > 0 ||
              (column.id === 'ISSUES' && showInlineForm),
            content: renderColumn(column),
          }))}
          showInlineForm={showInlineForm}
          inlineFormRequest={inlineFormRequest}
          workspaceCreationRequest={workspaceCreationRequest}
        />
      ) : (
        <div className="flex flex-row gap-4 pb-4 flex-1 min-h-0 overflow-y-hidden overflow-x-auto mx-auto w-full max-w-[1800px]">
          {columns.map(renderColumn)}
        </div>
      )}
      {isSelecting && (
        <BoardSelectionBar
          count={selectedIds.length}
          isArchiving={selectionArchives > 0}
          onArchive={handleArchiveSelection}
          onCancel={stopSelecting}
          archiveRef={archiveSelectionRef}
          cancelRef={cancelSelectionRef}
        />
      )}
      <ArchiveSelectionDialog
        open={archiveDialogOpen}
        onOpenChange={handleArchiveDialogOpenChange}
        workspaces={archiveTarget?.workspaces ?? []}
        scope={archiveTarget?.scope}
        onConfirm={handleArchiveConfirm}
      />
      {archiveGitLockDialog}
      <LazyQuickChatSheet workspaceId={quickChatWorkspaceId} onClose={closeQuickChat} />
    </div>
  );
}

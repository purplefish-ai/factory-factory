import { AlertCircle } from 'lucide-react';
import { trpc } from '@/frontend/lib/trpc';

import {
  type ChangeListEntry,
  PanelEmptyState,
  PanelErrorState,
  PanelLoadingState,
  ScrollableChangeSections,
  useOpenDiffTab,
  VirtualizedChangeList,
} from './change-panel-shared';
import { fileChangeKindFromDiffStatus } from './file-change-item';

// =============================================================================
// Types
// =============================================================================

type DiffFileStatus = 'added' | 'modified' | 'deleted';

interface DiffFile {
  path: string;
  status: DiffFileStatus;
}

interface DiffVsMainPanelProps {
  workspaceId: string;
}

// =============================================================================
// Main Component
// =============================================================================

export function DiffVsMainPanel({ workspaceId }: DiffVsMainPanelProps) {
  const openDiffTab = useOpenDiffTab();

  const { data, isLoading, error } = trpc.workspace.getDiffVsMain.useQuery(
    { workspaceId },
    { refetchInterval: 15_000, staleTime: 10_000 }
  );

  if (isLoading) {
    return <PanelLoadingState />;
  }

  if (error) {
    return <PanelErrorState title="Failed to load diff vs main" errorMessage={error.message} />;
  }

  const { added, modified, deleted, noMergeBase } = data ?? {
    added: [],
    modified: [],
    deleted: [],
    noMergeBase: false,
  };
  const hasChanges = added.length > 0 || modified.length > 0 || deleted.length > 0;
  const totalFiles = added.length + modified.length + deleted.length;

  if (noMergeBase) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-4">
        <AlertCircle className="h-8 w-8 text-warning mb-2" />
        <p className="text-sm font-medium text-muted-foreground">No common history with main</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          This branch doesn't share history with the main branch
        </p>
      </div>
    );
  }

  if (!hasChanges) {
    return (
      <PanelEmptyState
        title="Up to date with main"
        description="No changes compared to main branch"
      />
    );
  }

  const toEntry = (file: DiffFile): ChangeListEntry => ({
    path: file.path,
    kind: fileChangeKindFromDiffStatus(file.status),
    statusCode: file.status[0],
  });
  const addedEntries = added.map(toEntry);
  const modifiedEntries = modified.map(toEntry);
  const deletedEntries = deleted.map(toEntry);

  // Use virtualization for large lists (>200 total files)
  if (totalFiles > 200) {
    const allEntries = [...addedEntries, ...modifiedEntries, ...deletedEntries];

    return (
      <div className="h-full flex flex-col">
        <div className="p-2 pb-1 border-b text-xs text-muted-foreground">
          {added.length > 0 && <span className="text-green-500">+{added.length}</span>}
          {added.length > 0 && modified.length > 0 && <span className="mx-1">·</span>}
          {modified.length > 0 && <span className="text-yellow-500">~{modified.length}</span>}
          {(added.length > 0 || modified.length > 0) && deleted.length > 0 && (
            <span className="mx-1">·</span>
          )}
          {deleted.length > 0 && <span className="text-red-500">-{deleted.length}</span>}
        </div>
        <VirtualizedChangeList entries={allEntries} onFileClick={openDiffTab} className="flex-1" />
      </div>
    );
  }

  return (
    <ScrollableChangeSections
      sections={[
        { key: 'added', title: 'Added', entries: addedEntries },
        { key: 'modified', title: 'Modified', entries: modifiedEntries },
        { key: 'deleted', title: 'Deleted', entries: deletedEntries },
      ]}
      onFileClick={openDiffTab}
    />
  );
}

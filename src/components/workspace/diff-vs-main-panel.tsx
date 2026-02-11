import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertCircle, FileCode, Loader2 } from 'lucide-react';
import { memo, useCallback, useRef } from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { trpc } from '@/frontend/lib/trpc';

import { FileChangeItem, fileChangeKindFromDiffStatus } from './file-change-item';
import { useWorkspacePanel } from './workspace-panel-context';

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

// Helper component for virtualized file list
interface VirtualizedFileListProps {
  files: DiffFile[];
  onFileClick: (file: DiffFile) => void;
}

const VirtualizedFileList = memo(function VirtualizedFileList({
  files,
  onFileClick,
}: VirtualizedFileListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 10,
  });

  return (
    <div ref={parentRef} className="flex-1 overflow-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const file = files[virtualItem.index];
          if (!file) {
            return null;
          }
          return (
            <div
              key={virtualItem.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <FileChangeItem
                path={file.path}
                kind={fileChangeKindFromDiffStatus(file.status)}
                statusCode={file.status[0]}
                onClick={() => onFileClick(file)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});

// Component for rendering categorized file sections
interface CategorizedFilesProps {
  added: DiffFile[];
  modified: DiffFile[];
  deleted: DiffFile[];
  onFileClick: (file: DiffFile) => void;
}

const CategorizedFiles = memo(function CategorizedFiles({
  added,
  modified,
  deleted,
  onFileClick,
}: CategorizedFilesProps) {
  return (
    <ScrollArea className="h-full">
      <div className="p-2 space-y-3">
        {added.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-3 mb-1">
              Added ({added.length})
            </h3>
            <div className="space-y-0.5">
              {added.map((file) => (
                <FileChangeItem
                  key={file.path}
                  path={file.path}
                  kind={fileChangeKindFromDiffStatus(file.status)}
                  statusCode={file.status[0]}
                  onClick={() => onFileClick(file)}
                />
              ))}
            </div>
          </div>
        )}

        {modified.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-3 mb-1">
              Modified ({modified.length})
            </h3>
            <div className="space-y-0.5">
              {modified.map((file) => (
                <FileChangeItem
                  key={file.path}
                  path={file.path}
                  kind={fileChangeKindFromDiffStatus(file.status)}
                  statusCode={file.status[0]}
                  onClick={() => onFileClick(file)}
                />
              ))}
            </div>
          </div>
        )}

        {deleted.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-3 mb-1">
              Deleted ({deleted.length})
            </h3>
            <div className="space-y-0.5">
              {deleted.map((file) => (
                <FileChangeItem
                  key={file.path}
                  path={file.path}
                  kind={fileChangeKindFromDiffStatus(file.status)}
                  statusCode={file.status[0]}
                  onClick={() => onFileClick(file)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
});

export function DiffVsMainPanel({ workspaceId }: DiffVsMainPanelProps) {
  const { openTab } = useWorkspacePanel();

  const { data, isLoading, error } = trpc.workspace.getDiffVsMain.useQuery(
    { workspaceId },
    { refetchInterval: 15_000, staleTime: 10_000 }
  );

  const handleFileClick = useCallback(
    (file: DiffFile) => {
      openTab('diff', file.path, `Diff: ${file.path.split('/').pop()}`);
    },
    [openTab]
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-4">
        <AlertCircle className="h-8 w-8 text-destructive mb-2" />
        <p className="text-sm text-destructive">Failed to load diff vs main</p>
        <p className="text-xs text-muted-foreground mt-1">{error.message}</p>
      </div>
    );
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
      <div className="flex flex-col items-center justify-center h-full text-center p-4">
        <FileCode className="h-8 w-8 text-muted-foreground mb-2" />
        <p className="text-sm font-medium text-muted-foreground">Up to date with main</p>
        <p className="text-xs text-muted-foreground/70 mt-1">No changes compared to main branch</p>
      </div>
    );
  }

  // Use virtualization for large lists (>200 total files)
  if (totalFiles > 200) {
    const allFiles = [...added, ...modified, ...deleted];

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
        <VirtualizedFileList files={allFiles} onFileClick={handleFileClick} />
      </div>
    );
  }

  return (
    <CategorizedFiles
      added={added}
      modified={modified}
      deleted={deleted}
      onFileClick={handleFileClick}
    />
  );
}

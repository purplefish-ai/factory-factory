import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertCircle, FileCode, FileMinus, FilePlus, FileQuestion, Loader2 } from 'lucide-react';
import { memo, useCallback, useRef } from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { trpc } from '@/frontend/lib/trpc';
import { cn } from '@/lib/utils';

import { useWorkspacePanel } from './workspace-panel-context';

// =============================================================================
// Types
// =============================================================================

type GitFileStatus = 'M' | 'A' | 'D' | '?';

interface GitStatusFile {
  path: string;
  status: GitFileStatus;
  staged: boolean;
}

interface UnstagedChangesPanelProps {
  workspaceId: string;
}

// =============================================================================
// Helper Components
// =============================================================================

function getStatusIcon(status: GitFileStatus) {
  switch (status) {
    case 'M':
      return <FileCode className="h-4 w-4" />;
    case 'A':
      return <FilePlus className="h-4 w-4" />;
    case 'D':
      return <FileMinus className="h-4 w-4" />;
    case '?':
      return <FileQuestion className="h-4 w-4" />;
  }
}

function getStatusColor(status: GitFileStatus): string {
  switch (status) {
    case 'M':
      return 'text-yellow-500';
    case 'A':
      return 'text-green-500';
    case 'D':
      return 'text-red-500';
    case '?':
      return 'text-muted-foreground';
  }
}

function getStatusLabel(status: GitFileStatus): string {
  switch (status) {
    case 'M':
      return 'Modified';
    case 'A':
      return 'Added';
    case 'D':
      return 'Deleted';
    case '?':
      return 'Untracked';
  }
}

interface FileItemProps {
  file: GitStatusFile;
  onClick: () => void;
}

const FileItem = memo(function FileItem({ file, onClick }: FileItemProps) {
  const statusColor = getStatusColor(file.status);
  const fileName = file.path.split('/').pop() ?? file.path;
  const dirPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left',
        'hover:bg-muted/50 rounded-md transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
      title={`${getStatusLabel(file.status)}: ${file.path}`}
    >
      <span className={statusColor}>{getStatusIcon(file.status)}</span>
      <span className="flex-1 truncate">
        <span className="font-medium">{fileName}</span>
        {dirPath && <span className="text-muted-foreground ml-1 text-xs">{dirPath}</span>}
      </span>
      <span className={cn('text-xs font-mono', statusColor)}>{file.status}</span>
    </button>
  );
});

// =============================================================================
// Main Component
// =============================================================================

export function UnstagedChangesPanel({ workspaceId }: UnstagedChangesPanelProps) {
  const { openTab } = useWorkspacePanel();
  const parentRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, error } = trpc.workspace.getUnstagedChanges.useQuery(
    { workspaceId },
    { refetchInterval: 15_000, staleTime: 10_000 }
  );

  const handleFileClick = useCallback(
    (file: GitStatusFile) => {
      openTab('diff', file.path, `Diff: ${file.path.split('/').pop()}`);
    },
    [openTab]
  );

  const files = data?.files ?? [];

  // Use virtualization for large file lists (>200 files)
  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32, // Estimated height of each file item
    overscan: 10,
  });

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
        <p className="text-sm text-destructive">Failed to load unstaged changes</p>
        <p className="text-xs text-muted-foreground mt-1">{error.message}</p>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-4">
        <FileCode className="h-8 w-8 text-muted-foreground mb-2" />
        <p className="text-sm font-medium text-muted-foreground">No unstaged changes</p>
        <p className="text-xs text-muted-foreground/70 mt-1">All changes are staged or committed</p>
      </div>
    );
  }

  // Use virtualization for large lists
  if (files.length > 200) {
    return (
      <div ref={parentRef} className="h-full overflow-auto">
        <div
          className="p-2"
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            // biome-ignore lint/style/noNonNullAssertion: index provided by virtualizer within bounds
            const file = files[virtualItem.index]!;
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
                <FileItem file={file} onClick={() => handleFileClick(file)} />
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // For smaller lists, render normally without virtualization
  return (
    <ScrollArea className="h-full">
      <div className="p-2 space-y-0.5">
        {files.map((file) => (
          <FileItem key={file.path} file={file} onClick={() => handleFileClick(file)} />
        ))}
      </div>
    </ScrollArea>
  );
}

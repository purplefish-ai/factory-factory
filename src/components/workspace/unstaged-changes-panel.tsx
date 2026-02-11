import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertCircle, FileCode, Loader2 } from 'lucide-react';
import { useCallback, useRef } from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { trpc } from '@/frontend/lib/trpc';

import { FileChangeItem, fileChangeKindFromGitStatus } from './file-change-item';
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
                  kind={fileChangeKindFromGitStatus(file.status)}
                  statusCode={file.status}
                  onClick={() => handleFileClick(file)}
                />
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
          <FileChangeItem
            key={file.path}
            path={file.path}
            kind={fileChangeKindFromGitStatus(file.status)}
            statusCode={file.status}
            onClick={() => handleFileClick(file)}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

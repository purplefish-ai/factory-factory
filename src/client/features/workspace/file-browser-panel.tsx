import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { useCallback } from 'react';
import { IconButton } from '@/client/components/icon-button';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { ScrollArea } from '@/components/ui/scroll-area';
import { FileTree } from './file-tree';
import { FileTreeProvider } from './file-tree-context';
import { useWorkspacePanel } from './workspace-panel-context';

// =============================================================================
// Types
// =============================================================================

interface FileBrowserPanelProps {
  workspaceId: string;
}

// =============================================================================
// Main Component
// =============================================================================

export function FileBrowserPanel({ workspaceId }: FileBrowserPanelProps) {
  const { openTab } = useWorkspacePanel();
  const utils = trpc.useUtils();

  const handleFileSelect = useCallback(
    (path: string, name: string) => {
      openTab('file', path, name);
    },
    [openTab]
  );

  const handleRefresh = useCallback(() => {
    runInBackground(
      utils.workspace.listFiles.invalidate({ workspaceId }),
      "Couldn't refresh file tree."
    );
  }, [utils, workspaceId]);

  return (
    <FileTreeProvider workspaceId={workspaceId}>
      <div className="h-full flex flex-col">
        {/* Header with refresh button */}
        <div className="flex items-center justify-end px-2 py-1 border-b">
          <IconButton label="Refresh file tree" size="icon-xs" onClick={handleRefresh}>
            <ArrowsClockwiseIcon />
          </IconButton>
        </div>

        {/* File tree */}
        <ScrollArea className="flex-1">
          <div className="p-1">
            <FileTree workspaceId={workspaceId} onFileSelect={handleFileSelect} />
          </div>
        </ScrollArea>
      </div>
    </FileTreeProvider>
  );
}

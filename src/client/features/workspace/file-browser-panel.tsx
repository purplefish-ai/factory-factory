import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { useCallback } from 'react';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
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
      'Could not refresh file tree'
    );
  }, [utils, workspaceId]);

  return (
    <FileTreeProvider workspaceId={workspaceId}>
      <div className="h-full flex flex-col">
        {/* Header with refresh button */}
        <div className="flex items-center justify-end px-2 py-1 border-b">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRefresh}
            className="h-6 w-6"
            title="Refresh file tree"
          >
            <ArrowsClockwiseIcon className="h-3.5 w-3.5" />
          </Button>
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

'use client';

import { RefreshCw } from 'lucide-react';
import { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

import { FileTree } from './file-tree';
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
  const [refreshKey, setRefreshKey] = useState(0);

  const handleFileSelect = useCallback(
    (path: string, name: string) => {
      openTab('file', path, name);
    },
    [openTab]
  );

  const handleRefresh = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  return (
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
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* File tree */}
      <ScrollArea className="flex-1">
        <div className="p-1">
          <FileTree key={refreshKey} workspaceId={workspaceId} onFileSelect={handleFileSelect} />
        </div>
      </ScrollArea>
    </div>
  );
}

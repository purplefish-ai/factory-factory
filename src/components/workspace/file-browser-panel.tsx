'use client';

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

  const handleFileSelect = (path: string, name: string) => {
    openTab('file', path, name);
  };

  return (
    <ScrollArea className="h-full">
      <div className="p-1">
        <FileTree workspaceId={workspaceId} onFileSelect={handleFileSelect} />
      </div>
    </ScrollArea>
  );
}

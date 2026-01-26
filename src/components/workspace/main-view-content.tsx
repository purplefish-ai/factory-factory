'use client';

import { cn } from '@/lib/utils';

import { DiffViewer } from './diff-viewer';
import { FileViewer } from './file-viewer';
import { useWorkspacePanel } from './workspace-panel-context';

// =============================================================================
// Main Component
// =============================================================================

interface MainViewContentProps {
  workspaceId: string;
  children: React.ReactNode; // The existing chat content
  className?: string;
}

export function MainViewContent({ workspaceId, children, className }: MainViewContentProps) {
  const { tabs, activeTabId } = useWorkspacePanel();

  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  if (!activeTab) {
    // Fallback to chat if no active tab found
    return <div className={cn('h-full', className)}>{children}</div>;
  }

  return (
    <div className={cn('h-full', className)}>
      {activeTab.type === 'chat' && children}
      {activeTab.type === 'file' && activeTab.path && (
        <FileViewer workspaceId={workspaceId} filePath={activeTab.path} />
      )}
      {activeTab.type === 'diff' && activeTab.path && (
        <DiffViewer workspaceId={workspaceId} filePath={activeTab.path} />
      )}
    </div>
  );
}

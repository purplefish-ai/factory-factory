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

  // Determine what's visible
  const showChat = !activeTab || activeTab.type === 'chat';
  const filePath = activeTab?.type === 'file' ? activeTab.path : undefined;
  const diffPath = activeTab?.type === 'diff' ? activeTab.path : undefined;
  const activeTabKey = activeTab?.id;

  return (
    <div className={cn('h-full', className)}>
      {/* Always render chat children but hide when not active.
          This prevents unmounting/remounting which causes state loss. */}
      <div className={cn('h-full', !showChat && 'hidden')}>{children}</div>
      {filePath && activeTabKey && (
        <FileViewer workspaceId={workspaceId} filePath={filePath} tabId={activeTabKey} />
      )}
      {diffPath && activeTabKey && (
        <DiffViewer workspaceId={workspaceId} filePath={diffPath} tabId={activeTabKey} />
      )}
    </div>
  );
}

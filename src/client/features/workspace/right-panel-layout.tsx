import { type ReactNode, useState } from 'react';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { TabsContent } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { MobileToolSwitcher } from './mobile-tool-switcher';
import type { TopPanelTab } from './right-panel-state';
import { useWorkspacePanelState } from './workspace-panel-context';

export function RightPanelLayout({
  workspaceId,
  isMobile,
  mobilePanel,
  activeTopTab,
  unreadCount,
  showRuns,
  onOpenLogs,
  className,
  topPanel,
  bottomPanel,
}: {
  workspaceId: string;
  isMobile: boolean;
  mobilePanel: 'top' | 'bottom';
  activeTopTab: TopPanelTab;
  unreadCount?: number;
  /** Whether the workspace has a Runs tab (an automation origin). */
  showRuns: boolean;
  onOpenLogs: () => void;
  className?: string;
  topPanel: ReactNode;
  bottomPanel: ReactNode;
}) {
  const { activeBottomTab } = useWorkspacePanelState();
  const [bottomMountedFor, setBottomMountedFor] = useState<string | null>(null);
  if (mobilePanel === 'bottom' && bottomMountedFor !== workspaceId) {
    setBottomMountedFor(workspaceId);
  }
  // The outer route also remounts tools when crossing the modal/desktop boundary.
  // Fold widths within the compact range keep this panel tree mounted.
  if (isMobile) {
    return (
      <div className={cn('flex h-full min-h-0 flex-col', className)}>
        <MobileToolSwitcher
          activeTopTab={activeTopTab}
          showRuns={showRuns}
          onOpenLogs={onOpenLogs}
          unreadCount={unreadCount}
        >
          <TabsContent
            forceMount
            value={activeTopTab}
            hidden={mobilePanel !== 'top'}
            className="min-h-0 flex-1"
          >
            {topPanel}
          </TabsContent>
          {bottomMountedFor === workspaceId && (
            <TabsContent
              forceMount
              value={activeBottomTab === 'terminal' ? 'terminal' : 'logs'}
              hidden={mobilePanel !== 'bottom'}
              className="min-h-0 flex-1"
            >
              {bottomPanel}
            </TabsContent>
          )}
        </MobileToolSwitcher>
      </div>
    );
  }
  return (
    <ResizablePanelGroup
      direction="vertical"
      className={cn('h-full', className)}
      autoSaveId="workspace-right-panel"
    >
      <ResizablePanel defaultSize="60%" minSize="20%">
        {topPanel}
      </ResizablePanel>
      <ResizableHandle direction="vertical" />
      <ResizablePanel defaultSize="40%" minSize="15%">
        {bottomPanel}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

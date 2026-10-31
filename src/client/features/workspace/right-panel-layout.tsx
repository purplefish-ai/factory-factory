import { type ReactNode, useState } from 'react';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { cn } from '@/lib/utils';
import { MobileToolSwitcher } from './mobile-tool-switcher';

export function RightPanelLayout({
  workspaceId,
  isMobile,
  mobilePanel,
  periodicTaskId,
  onOpenLogs,
  className,
  topPanel,
  bottomPanel,
}: {
  workspaceId: string;
  isMobile: boolean;
  mobilePanel: 'top' | 'bottom';
  periodicTaskId: string | null;
  onOpenLogs: () => void;
  className?: string;
  topPanel: ReactNode;
  bottomPanel: ReactNode;
}) {
  const [bottomMountedFor, setBottomMountedFor] = useState<string | null>(null);
  if (mobilePanel === 'bottom' && bottomMountedFor !== workspaceId) {
    setBottomMountedFor(workspaceId);
  }
  // The outer route also remounts tools when crossing the modal/desktop boundary.
  // Fold widths within the compact range keep this panel tree mounted.
  if (isMobile) {
    return (
      <div className={cn('flex h-full min-h-0 flex-col', className)}>
        <MobileToolSwitcher periodicTaskId={periodicTaskId} onOpenLogs={onOpenLogs} />
        <div hidden={mobilePanel !== 'top'} className="min-h-0 flex-1">
          {topPanel}
        </div>
        {bottomMountedFor === workspaceId && (
          <div hidden={mobilePanel !== 'bottom'} className="min-h-0 flex-1">
            {bottomPanel}
          </div>
        )}
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

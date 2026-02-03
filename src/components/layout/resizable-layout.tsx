import type { ReactNode } from 'react';

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { SidebarProvider } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

interface ResizableLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
  className?: string;
}

export function ResizableLayout({ sidebar, children, className }: ResizableLayoutProps) {
  return (
    <SidebarProvider>
      {sidebar ? (
        <ResizablePanelGroup
          direction="horizontal"
          className={cn('h-svh w-full', className)}
          autoSaveId="app-sidebar-layout"
        >
          {/* Left sidebar panel */}
          <ResizablePanel defaultSize="15%" minSize="10%" maxSize="30%">
            {sidebar}
          </ResizablePanel>

          <ResizableHandle />

          {/* Main content panel */}
          <ResizablePanel defaultSize="85%" minSize="50%">
            <main className="relative flex min-h-0 h-full w-full flex-1 flex-col overflow-hidden bg-background">
              {children}
            </main>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <main
          className={cn(
            'relative flex min-h-0 h-svh w-full flex-1 flex-col overflow-hidden bg-background',
            className
          )}
        >
          {children}
        </main>
      )}
    </SidebarProvider>
  );
}

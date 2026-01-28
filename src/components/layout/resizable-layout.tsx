'use client';

import type { CSSProperties, ReactNode } from 'react';

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { SidebarProvider } from '@/components/ui/sidebar';

interface ResizableLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
}

export function ResizableLayout({ sidebar, children }: ResizableLayoutProps) {
  return (
    <SidebarProvider>
      <ResizablePanelGroup
        direction="horizontal"
        className="h-svh w-full"
        style={{ '--sidebar-width': '100%' } as CSSProperties}
        autoSaveId="app-sidebar-layout"
      >
        {/* Left sidebar panel */}
        <ResizablePanel defaultSize="15%" minSize="10%" maxSize="30%">
          {sidebar}
        </ResizablePanel>

        <ResizableHandle />

        {/* Main content panel */}
        <ResizablePanel defaultSize="85%" minSize="50%">
          <main className="relative flex min-h-0 w-full flex-1 flex-col overflow-y-auto bg-background">
            {children}
          </main>
        </ResizablePanel>
      </ResizablePanelGroup>
    </SidebarProvider>
  );
}

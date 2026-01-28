'use client';

import type { ReactNode } from 'react';

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
    </SidebarProvider>
  );
}

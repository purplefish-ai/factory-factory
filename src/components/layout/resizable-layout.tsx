'use client';

import { createContext, type ReactNode, useContext, useState } from 'react';

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { SidebarProvider } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

// Context to allow sidebar component to hide the entire sidebar panel
interface SidebarVisibilityContextType {
  isSidebarVisible: boolean;
  setIsSidebarVisible: (visible: boolean) => void;
}

const SidebarVisibilityContext = createContext<SidebarVisibilityContextType>({
  isSidebarVisible: true,
  // biome-ignore lint/suspicious/noEmptyBlockStatements: default no-op for context
  setIsSidebarVisible: () => {},
});

export function useSidebarVisibility() {
  return useContext(SidebarVisibilityContext);
}

interface ResizableLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
  className?: string;
}

export function ResizableLayout({ sidebar, children, className }: ResizableLayoutProps) {
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);

  return (
    <SidebarVisibilityContext.Provider value={{ isSidebarVisible, setIsSidebarVisible }}>
      <SidebarProvider>
        {isSidebarVisible ? (
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
    </SidebarVisibilityContext.Provider>
  );
}

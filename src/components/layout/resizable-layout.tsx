import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { LogoIcon } from '@/frontend/components/logo';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

interface ResizableLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
  className?: string;
}

export function ResizableLayout({ sidebar, children, className }: ResizableLayoutProps) {
  const isMobile = useIsMobile();

  return (
    <SidebarProvider>
      {sidebar ? (
        isMobile ? (
          <div className={cn('h-svh w-full flex flex-col', className)}>
            {/* On mobile, sidebar renders as a Sheet (drawer) via the Sidebar component */}
            {sidebar}
            <header className="flex items-center gap-3 border-b px-3 py-2.5 shrink-0">
              <Link to="/projects" className="shrink-0">
                <LogoIcon className="size-12" />
              </Link>
              <div id="mobile-project-selector-slot" className="flex-1 min-w-0" />
              <SidebarTrigger />
            </header>
            <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
              {children}
            </main>
          </div>
        ) : (
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
        )
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

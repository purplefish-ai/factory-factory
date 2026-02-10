import { createContext, type ReactNode, useContext, useState } from 'react';
import { Link } from 'react-router';

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { LogoIcon } from '@/frontend/components/logo';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

/**
 * Context to share the mobile project selector portal target element.
 * The slot div is rendered in the mobile top bar header, and the AppSidebar
 * portals the project selector dropdown into it via this context.
 */
const MobileSlotContext = createContext<HTMLElement | null>(null);

export function useMobileProjectSlot(): HTMLElement | null {
  return useContext(MobileSlotContext);
}

interface ResizableLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
  className?: string;
}

export function ResizableLayout({ sidebar, children, className }: ResizableLayoutProps) {
  const isMobile = useIsMobile();
  const [slotElement, setSlotElement] = useState<HTMLElement | null>(null);

  return (
    <SidebarProvider>
      {sidebar ? (
        isMobile ? (
          <MobileSlotContext.Provider value={slotElement}>
            <div className={cn('h-svh w-full flex flex-col', className)}>
              <header className="flex items-center gap-2 border-b px-2 py-2 shrink-0">
                <Link to="/projects" className="shrink-0">
                  <LogoIcon className="size-10" />
                </Link>
                <div ref={setSlotElement} className="flex-1 min-w-0" />
                <SidebarTrigger />
              </header>
              {/* Sidebar renders as a Sheet (overlay) on mobile, so DOM order doesn't affect layout */}
              {sidebar}
              <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
                {children}
              </main>
            </div>
          </MobileSlotContext.Provider>
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

import type { ReactNode } from 'react';

import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppHeader } from '@/frontend/components/app-header';
import { AppHeaderProvider } from '@/frontend/components/app-header-context';
import { AppSidebar } from '@/frontend/components/app-sidebar';
import { useAppNavigationData } from '@/frontend/hooks/use-app-navigation-data';
import { useRouteSidebarState } from '@/frontend/hooks/use-sidebar-default-open';
import { cn } from '@/lib/utils';

interface AppLayoutProps {
  children: ReactNode;
  className?: string;
}

export function AppLayout({ children, className }: AppLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useRouteSidebarState();
  const navData = useAppNavigationData();

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <TooltipProvider delayDuration={0}>
        <SidebarProvider
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          className="flex-1 flex-col min-h-0"
        >
          <AppHeaderProvider>
            <AppHeader />
            <div className="flex flex-1 min-h-0 overflow-hidden">
              <AppSidebar navData={navData} />
              <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
                {children}
              </main>
            </div>
          </AppHeaderProvider>
        </SidebarProvider>
      </TooltipProvider>
    </div>
  );
}

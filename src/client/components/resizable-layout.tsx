import type { ReactNode } from 'react';
import { AppHeader } from '@/client/components/app-header';
import { AppHeaderProvider } from '@/client/components/app-header-context';
import { AppShortcuts } from '@/client/components/app-shortcuts';
import { AppSidebar } from '@/client/components/app-sidebar';
import { ErrorBoundary } from '@/client/error-boundary';
import {
  AppNavigationDataProvider,
  useAppNavigationData,
} from '@/client/hooks/use-app-navigation-data';
import { useRouteSidebarState } from '@/client/hooks/use-sidebar-default-open';
import { SidebarProvider, useSidebar } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * The sidebar renders outside the page boundary. Its fallback takes the
 * sidebar's place only while the sidebar (or the mobile sheet) is open.
 */
function SidebarBoundary({ children }: { children: ReactNode }) {
  const { isMobile, open, openMobile } = useSidebar();
  const visible = isMobile ? openMobile : open;
  return (
    <ErrorBoundary
      variant="compact"
      title="Couldn't show the sidebar"
      showRetry
      className={cn('w-(--sidebar-width) max-w-[80vw] shrink-0 border-r', !visible && 'hidden')}
    >
      {children}
    </ErrorBoundary>
  );
}

interface AppLayoutProps {
  children: ReactNode;
  className?: string;
  banners?: ReactNode;
}

export function AppLayout({ children, className, banners }: AppLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useRouteSidebarState();
  const navData = useAppNavigationData();
  const isFirstRun = navData.projects?.length === 0 && !navData.projectsError;

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <TooltipProvider delayDuration={0}>
        <SidebarProvider
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          className="flex-1 flex-col min-h-0"
        >
          <AppNavigationDataProvider value={navData}>
            <AppHeaderProvider>
              <AppShortcuts navData={navData} />
              <AppHeader showSidebarToggle={!isFirstRun} />
              {banners}
              <div className="flex flex-1 min-h-0 overflow-hidden">
                {isFirstRun ? null : (
                  <SidebarBoundary>
                    <AppSidebar navData={navData} />
                  </SidebarBoundary>
                )}
                <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
                  {children}
                </main>
              </div>
            </AppHeaderProvider>
          </AppNavigationDataProvider>
        </SidebarProvider>
      </TooltipProvider>
    </div>
  );
}

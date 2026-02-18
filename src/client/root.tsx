import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { ResizableLayout } from '@/components/layout/resizable-layout';
import { Toaster } from '@/components/ui/sonner';
import { WorkspaceNotificationManager } from '@/components/workspace/WorkspaceNotificationManager';
import { AppSidebar } from '@/frontend/components/app-sidebar';
import { CLIHealthBanner } from '@/frontend/components/cli-health-banner';
import { ThemeProvider } from '@/frontend/components/theme-provider';
import { TRPCProvider, useProjects } from '@/frontend/lib/providers';
import { useVisualViewportHeight } from '@/hooks/use-visual-viewport-height';

function RootLayout() {
  const { projects, isLoading } = useProjects();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const showSidebar = !isLoading && projects && projects.length > 0;
  const { height: viewportHeight, offsetTop: viewportOffsetTop } = useVisualViewportHeight();
  const viewportTransform =
    viewportOffsetTop === '0px' ? undefined : `translateY(${viewportOffsetTop})`;

  // Redirect to onboarding when no projects exist
  // Only redirect from top-level paths, not from specific project routes
  useEffect(() => {
    const isProjectSpecificRoute = /^\/projects\/[^/]+/.test(pathname);
    if (
      !isLoading &&
      projects?.length === 0 &&
      !pathname.startsWith('/projects/new') &&
      !isProjectSpecificRoute
    ) {
      void navigate('/projects/new');
    }
  }, [isLoading, projects, pathname, navigate]);

  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{ height: viewportHeight, transform: viewportTransform }}
    >
      <CLIHealthBanner />
      <ResizableLayout
        sidebar={showSidebar ? <AppSidebar /> : null}
        className="flex-1 overflow-hidden"
      >
        <Outlet />
      </ResizableLayout>
    </div>
  );
}

export function Root() {
  return (
    <ThemeProvider>
      <TRPCProvider>
        <WorkspaceNotificationManager />
        <RootLayout />
        <Toaster />
      </TRPCProvider>
    </ThemeProvider>
  );
}

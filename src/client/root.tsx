import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { CLIHealthBanner } from '@/client/components/cli-health-banner';
import { ThemeProvider } from '@/client/components/theme-provider';
import { TRPCProvider, useProjects } from '@/client/lib/providers';
import { AppLayout } from '@/components/layout/resizable-layout';
import { Toaster } from '@/components/ui/sonner';
import { WorkspaceNotificationManager } from '@/components/workspace/WorkspaceNotificationManager';
import { useVisualViewportHeight } from '@/hooks/use-visual-viewport-height';

function RootLayout() {
  const { projects, isLoading } = useProjects();
  const navigate = useNavigate();
  const { pathname } = useLocation();
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
      <AppLayout className="flex-1 overflow-hidden">
        <Outlet />
      </AppLayout>
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

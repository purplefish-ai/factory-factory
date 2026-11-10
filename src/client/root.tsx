import { type ReactNode, Suspense, useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { AppearanceProvider } from '@/client/components/appearance-provider';
import { CLIHealthBanner } from '@/client/components/cli-health-banner';
import { FactoryUpdateBanner } from '@/client/components/factory-update-banner';
import { Loading } from '@/client/components/loading';
import { ModelCatalogWarning } from '@/client/components/model-catalog-warning';
import { AppLayout } from '@/client/components/resizable-layout';
import { ThemeProvider } from '@/client/components/theme-provider';
import { ErrorBoundary } from '@/client/error-boundary';
import { DataImportResultsProvider } from '@/client/features/data-import';
import { WorkspaceNotificationManager } from '@/client/features/workspace/WorkspaceNotificationManager';
import { hasExplicitLegacyProjectOwner } from '@/client/lib/project-navigation';
import { TRPCProvider, useProjects } from '@/client/lib/providers';
import { Toaster } from '@/components/ui/sonner';
import { useVisualViewportHeight } from '@/hooks/use-visual-viewport-height';

/** Banners render outside the page boundary; a failing one must not take down the app. */
function BannerBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      variant="compact"
      title="Couldn't show a notice"
      showRetry
      className="h-auto border-b py-2"
    >
      {children}
    </ErrorBoundary>
  );
}

function RootLayout() {
  const { projects, isLoading } = useProjects();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
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
      !isProjectSpecificRoute &&
      !/^\/admin\/project\/?$/i.test(pathname) &&
      !hasExplicitLegacyProjectOwner(pathname, search)
    ) {
      void navigate('/projects/new');
    }
  }, [isLoading, projects, pathname, search, navigate]);

  return (
    <div
      id="app-content"
      tabIndex={-1}
      className="flex flex-col overflow-hidden"
      style={{ height: viewportHeight, transform: viewportTransform }}
    >
      <AppLayout
        className="flex-1 overflow-hidden"
        banners={
          <>
            <BannerBoundary>
              <FactoryUpdateBanner />
            </BannerBoundary>
            <BannerBoundary>
              <CLIHealthBanner />
            </BannerBoundary>
            <BannerBoundary>
              <ModelCatalogWarning />
            </BannerBoundary>
          </>
        }
      >
        <ErrorBoundary resetKey={`${pathname}${search}`}>
          <Suspense fallback={<Loading message="Loading page…" />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </AppLayout>
    </div>
  );
}

export function Root() {
  return (
    <ThemeProvider>
      <TRPCProvider>
        <AppearanceProvider>
          <DataImportResultsProvider
            onDismiss={() => document.getElementById('app-content')?.focus()}
          >
            <WorkspaceNotificationManager />
            <RootLayout />
            <Toaster />
          </DataImportResultsProvider>
        </AppearanceProvider>
      </TRPCProvider>
    </ThemeProvider>
  );
}

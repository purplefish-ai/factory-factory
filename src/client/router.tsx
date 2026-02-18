import { lazy, Suspense } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { ThemeProvider } from '@/frontend/components/theme-provider';
import { TRPCProvider } from '@/frontend/lib/providers';
import { ErrorBoundary } from './error-boundary';
import { ProjectLayout } from './layouts/project-layout';
import { Root } from './root';
import AdminPage from './routes/admin-page';
// Route components
import HomePage from './routes/home';
import LogsPage from './routes/logs';
import ProjectsListPage from './routes/projects/list';
import NewProjectPage from './routes/projects/new';
import ProjectRedirectPage from './routes/projects/redirect';
import WorkspaceDetailPage from './routes/projects/workspaces/detail';
import WorkspacesListPage from './routes/projects/workspaces/list';
import NewWorkspacePage from './routes/projects/workspaces/new';
import ReviewsPage from './routes/reviews';

const MobileBaselinePage = lazy(() => import('./routes/mobile-baseline'));
const isDevelopmentMode = import.meta.env.MODE === 'development';
const enableMobileBaselineRoute =
  isDevelopmentMode || import.meta.env.VITE_ENABLE_MOBILE_BASELINE === '1';

export const router = createBrowserRouter([
  ...(enableMobileBaselineRoute
    ? [
        {
          path: '/__mobile-baseline',
          element: (
            <ErrorBoundary>
              <ThemeProvider>
                <TRPCProvider>
                  <Suspense fallback={null}>
                    <MobileBaselinePage />
                  </Suspense>
                </TRPCProvider>
              </ThemeProvider>
            </ErrorBoundary>
          ),
        },
      ]
    : []),
  {
    path: '/',
    element: (
      <ErrorBoundary>
        <Root />
      </ErrorBoundary>
    ),
    children: [
      {
        index: true,
        element: <HomePage />,
      },
      {
        path: 'projects',
        children: [
          {
            index: true,
            element: <ProjectsListPage />,
          },
          {
            path: 'new',
            element: <NewProjectPage />,
          },
          {
            path: ':slug',
            element: <ProjectLayout />,
            children: [
              {
                index: true,
                element: <ProjectRedirectPage />,
              },
              {
                path: 'workspaces',
                children: [
                  {
                    index: true,
                    element: <WorkspacesListPage />,
                  },
                  {
                    path: 'new',
                    element: <NewWorkspacePage />,
                  },
                  {
                    path: ':id',
                    element: <WorkspaceDetailPage />,
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        path: 'reviews',
        element: <ReviewsPage />,
      },
      {
        path: 'admin',
        element: <AdminPage />,
      },
      {
        path: 'logs',
        element: <LogsPage />,
      },
    ],
  },
]);

export function Router() {
  return <RouterProvider router={router} />;
}

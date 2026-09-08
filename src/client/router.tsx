import { lazy, Suspense } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { ThemeProvider } from '@/client/components/theme-provider';
import { TRPCProvider } from '@/client/lib/providers';
import { ErrorBoundary } from './error-boundary';
import { ProjectLayout } from './layouts/project-layout';
import { Root } from './root';

// Route modules load only when their page is rendered.
const AdminPage = lazy(() => import('./routes/admin-page'));
const HomePage = lazy(() => import('./routes/home'));
const LogsPage = lazy(() => import('./routes/logs'));
const ProjectsListPage = lazy(() => import('./routes/projects/list'));
const NewProjectPage = lazy(() => import('./routes/projects/new'));
const ProjectRedirectPage = lazy(() => import('./routes/projects/redirect'));
const WorkspaceDetailPage = lazy(() => import('./routes/projects/workspaces/detail'));
const WorkspacesListPage = lazy(() => import('./routes/projects/workspaces/list'));
const NewWorkspacePage = lazy(() => import('./routes/projects/workspaces/new'));
const ReviewsPage = lazy(() => import('./routes/reviews'));

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

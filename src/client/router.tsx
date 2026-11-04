import { lazy, Suspense } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { ThemeProvider } from '@/client/components/theme-provider';
import { TRPCProvider } from '@/client/lib/providers';
import { ErrorBoundary } from './error-boundary';
import { ProjectLayout } from './layouts/project-layout';
import { Root } from './root';

// Route modules load only when their page is rendered.
const AgentsPage = lazy(() => import('./routes/agents'));
const LegacyAgentsPage = lazy(() => import('./routes/agents/legacy'));
const AdminPage = lazy(() => import('./routes/admin-page'));
const HomePage = lazy(() => import('./routes/home'));
const LogsPage = lazy(() => import('./routes/logs'));
const ProjectSettingsPage = lazy(() => import('./routes/projects/settings'));
const ProjectsListPage = lazy(() => import('./routes/projects/list'));
const NewProjectPage = lazy(() => import('./routes/projects/new'));
const ProjectRedirectPage = lazy(() => import('./routes/projects/redirect'));
const WorkspaceDetailPage = lazy(() => import('./routes/projects/workspaces/detail'));
const WorkspacesListPage = lazy(() => import('./routes/projects/workspaces/list'));
// Retired standalone form; redirects to the board's inline new workspace form.
const NewWorkspaceRedirectPage = lazy(() => import('./routes/projects/workspaces/new'));
const ReviewsPage = lazy(() => import('./routes/reviews'));
const LegacyReviewsPage = lazy(() => import('./routes/reviews/legacy'));

const MobileBaselinePage = lazy(() => import('./routes/mobile-baseline'));
const TranscriptScrollFixture = lazy(() => import('./routes/transcript-scroll-fixture'));
const isDevelopmentMode = import.meta.env.MODE === 'development';
const enableMobileBaselineRoute =
  isDevelopmentMode || import.meta.env.VITE_ENABLE_MOBILE_BASELINE === '1';

export const router = createBrowserRouter([
  ...(isDevelopmentMode
    ? [
        {
          path: '/__transcript-scroll',
          element: (
            <Suspense fallback={null}>
              <TranscriptScrollFixture />
            </Suspense>
          ),
        },
      ]
    : []),
  ...(enableMobileBaselineRoute
    ? [
        {
          path: '/__mobile-baseline',
          element: (
            <ErrorBoundary className="min-h-dvh">
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
      <ErrorBoundary className="min-h-dvh">
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
          { path: ':slug/settings', element: <ProjectSettingsPage /> },
          {
            path: ':slug',
            element: <ProjectLayout />,
            children: [
              { path: 'agents/:id?', element: <AgentsPage /> },
              { path: 'reviews', element: <ReviewsPage /> },
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
                    element: <NewWorkspaceRedirectPage />,
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
        path: 'agents/:id?',
        element: <LegacyAgentsPage />,
      },
      {
        path: 'reviews',
        element: <LegacyReviewsPage />,
      },
      {
        path: 'admin/:section?',
        element: <AdminPage />,
      },
      { path: 'admin/logs', element: <LogsPage /> },
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

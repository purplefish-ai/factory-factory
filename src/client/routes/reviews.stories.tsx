import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router';
import { expect, fn, userEvent, within } from 'storybook/test';
import { AppHeaderProvider, useAppHeaderContext } from '@/client/components/app-header-context';
import { AppNavigationDataProvider } from '@/client/hooks/use-app-navigation-data';
import { useProjectReviewRequests } from '@/client/hooks/use-project-review-requests';
import { trpc } from '@/client/lib/trpc';
import ReviewsPage from './reviews';

const projects = [
  {
    id: 'alpha-id',
    slug: 'alpha',
    name: 'Alpha',
    githubOwner: 'org',
    githubRepo: 'alpha',
    issueProvider: 'GITHUB',
  },
  {
    id: 'beta-id',
    slug: 'beta',
    name: 'Beta',
    githubOwner: null,
    githubRepo: null,
    issueProvider: 'GITHUB',
  },
];

function ReviewsStory({ localOnly = false }: { localOnly?: boolean }) {
  const [queryClient] = useState(() => new QueryClient());
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              const data =
                op.path === 'project.list'
                  ? projects
                  : op.path === 'project.getBySlug'
                    ? projects.find(
                        (project) => project.slug === (op.input as { slug: string }).slug
                      )
                    : {
                        prs: [],
                        health: { isInstalled: true, isAuthenticated: true },
                        error: null,
                      };
              observer.next({ result: { data } });
              observer.complete();
            }),
      ],
    })
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AppHeaderProvider>
          <ReviewsHeader />
          <Routes>
            <Route
              path="/"
              element={
                <Navigate replace to={`/projects/${localOnly ? 'beta' : 'alpha'}/reviews`} />
              }
            />
            <Route path="/projects/:slug/reviews" element={<ReviewsStoryNavigation />} />
          </Routes>
        </AppHeaderProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

function ReviewsStoryNavigation() {
  const { slug = '' } = useParams();
  const list = trpc.project.list.useQuery({ isArchived: false });
  const project = trpc.project.getBySlug.useQuery({ slug });
  const reviews = useProjectReviewRequests(project.data);
  return (
    <AppNavigationDataProvider
      value={{
        projects: list.data,
        projectsError: null,
        refetchProjects: list.refetch,
        selectedProjectSlug: slug,
        selectedProjectId: project.data?.id,
        selectProjectSlug: fn(),
        issueProvider: 'GITHUB',
        serverWorkspaces: [],
        reviewCount: reviews.prs.filter((pr) => pr.reviewDecision !== 'APPROVED').length,
        needsAttention: () => false,
        clearAttention: fn(),
        currentWorkspaceId: undefined,
      }}
    >
      <div className="h-60">
        <ReviewsPage />
      </div>
    </AppNavigationDataProvider>
  );
}

function ReviewsHeader() {
  const { title, setLeftStartSlot } = useAppHeaderContext();
  return (
    <header className="flex items-center gap-3 border-b p-3">
      {title}
      <div ref={setLeftStartSlot} />
    </header>
  );
}
const meta = {
  title: 'Pages/Reviews',
  component: ReviewsStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ReviewsStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SelectedProject: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole('button', { name: 'Open Alpha workspaces' })
    ).toBeVisible();
    await expect(await within(canvasElement).findByText('No review requests')).toBeVisible();
  },
};
export const LocalProject: Story = {
  args: { localOnly: true },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText('This project has no linked GitHub repository')
    ).toBeVisible();
  },
};
export const SwitchProject: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('button', { name: 'Open Alpha workspaces' })
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('combobox', { name: 'Open project menu' }));
    await userEvent.click(await within(document.body).findByRole('option', { name: 'Beta' }));
    await expect(await canvas.findByRole('button', { name: 'Open Beta workspaces' })).toBeVisible();
    await expect(
      await canvas.findByText('This project has no linked GitHub repository')
    ).toBeVisible();
  },
};

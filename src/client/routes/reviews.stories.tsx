import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { expect, within } from 'storybook/test';
import { AppHeaderProvider, useAppHeaderContext } from '@/client/components/app-header-context';
import { SELECTED_PROJECT_KEY } from '@/client/lib/project-selection';
import { trpc } from '@/client/lib/trpc';
import ReviewsPage from './reviews';

function ReviewsStory() {
  const [queryClient] = useState(() => new QueryClient());
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              const data =
                op.path === 'project.list' ? [{ slug: 'alpha' }, { slug: 'beta' }] : { prs: [] };
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
          <div className="h-60">
            <ReviewsPage />
          </div>
        </AppHeaderProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

function ReviewsHeader() {
  const { title, setLeftExtraSlot } = useAppHeaderContext();
  return (
    <header className="flex items-center gap-3 border-b p-3">
      {title}
      <div ref={setLeftExtraSlot} />
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
  beforeEach: () => {
    const previous = localStorage.getItem(SELECTED_PROJECT_KEY);
    localStorage.setItem(SELECTED_PROJECT_KEY, 'beta');
    return () => {
      if (previous === null) {
        localStorage.removeItem(SELECTED_PROJECT_KEY);
      } else {
        localStorage.setItem(SELECTED_PROJECT_KEY, previous);
      }
    };
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole('link', { name: 'Workspaces' })
    ).toHaveAttribute('href', '/projects/beta/workspaces');
  },
};

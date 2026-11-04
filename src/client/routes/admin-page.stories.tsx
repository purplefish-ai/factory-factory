import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { expect, within } from 'storybook/test';
import { AppHeaderProvider } from '@/client/components/app-header-context';
import { DataImportResultsProvider } from '@/client/features/data-import';
import { trpc } from '@/client/lib/trpc';
import AdminDashboardPage from './admin-page';

/** Every request fails, as when the backend is down or restarting. */
function BackendUnavailableStory() {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () => () =>
          observable((observer) => {
            observer.error(new TRPCClientError('Service unavailable'));
          }),
      ],
    })
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AppHeaderProvider>
          <DataImportResultsProvider>
            <div className="h-screen">
              <AdminDashboardPage />
            </div>
          </DataImportResultsProvider>
        </AppHeaderProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: 'Settings/SettingsPage',
  component: BackendUnavailableStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof BackendUnavailableStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Failed stats and process queries show errors with Retry instead of zeroed counters. */
export const BackendUnavailable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Couldn't load API usage")).toBeVisible();
    await expect(await canvas.findByText("Couldn't load active processes")).toBeVisible();
  },
};

import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { AppHeaderProvider } from '@/client/components/app-header-context';
import { trpc } from '@/client/lib/trpc';
import LogsPage from './logs';

const onRequest = fn();
function LogsStory() {
  const [queryClient] = useState(() => new QueryClient());
  const [client] = useState(() => {
    const data = {
      entries: [
        {
          timestamp: new Date().toISOString(),
          level: 'info',
          component: 'story',
          message: 'Story log entry',
          context: {},
        },
      ],
      total: 1,
      totalIsExact: true,
      hasMore: false,
      filePath: 'server.log',
    };
    return trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              onRequest(op.path, op.input);
              observer.next({ result: { data } });
              observer.complete();
            }),
      ],
    });
  });
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AppHeaderProvider>
          <LogsPage />
        </AppHeaderProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
const meta = {
  title: 'Pages/Logs',
  component: LogsStory,
  parameters: { layout: 'fullscreen' },
  beforeEach: () => {
    onRequest.mockClear();
  },
} satisfies Meta<typeof LogsStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const RelativeRange: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Story log entry');
    const timeRange = canvas.getByText('All Time').closest('button');
    if (!timeRange) {
      throw new Error('Time range trigger is missing');
    }
    await userEvent.click(timeRange);
    await userEvent.click(
      await within(document.body).findByRole('option', { name: 'Last 5 minutes' })
    );
    await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.body).not.toHaveStyle({ pointerEvents: 'none' }));
    await userEvent.click(canvas.getByText('Story log entry'));
    await expect(await canvas.findByText('Raw JSON')).toBeVisible();
    await expect(onRequest).toHaveBeenCalledTimes(2);
  },
};

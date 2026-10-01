import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { trpc } from '@/client/lib/trpc';
import { IssueProvider } from '@/shared/core/enums';
import { ProjectIssueTrackingCard } from './IssueTrackingSection';

function FailedProviderSave({ initial }: { initial: IssueProvider }) {
  const [queryClient] = useState(() => new QueryClient());
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              if (op.path === 'project.list') {
                observer.next({ result: { data: [] } });
                observer.complete();
                return undefined;
              }
              const timer = setTimeout(() => {
                observer.error(new TRPCClientError('Mock provider save failed'));
              }, 250);
              return () => clearTimeout(timer);
            }),
      ],
    })
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <ProjectIssueTrackingCard
          projectId="mock-project"
          projectName="Mock project"
          currentProvider={initial}
          issueTrackerConfig={{
            linear: {
              hasApiKey: true,
              teamId: 'mock-team',
              teamName: 'Mock team',
              viewerName: 'Mock viewer',
            },
          }}
        />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: 'Pages/Admin/IssueProvider',
  parameters: { layout: 'padded' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const FailedSwitchToLinear: Story = {
  render: () => <FailedProviderSave initial={IssueProvider.GITHUB} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox'));
    await userEvent.click(
      await within(document.body).findByRole('option', { name: 'Linear Issues' })
    );
    await waitFor(() => expect(canvas.getByRole('combobox')).toHaveTextContent('GitHub Issues'));
    await expect(canvas.queryByLabelText('API Key')).not.toBeInTheDocument();
    await expect(canvas.getByText('GitHub', { exact: true })).toBeInTheDocument();
  },
};

export const FailedSwitchToGitHub: Story = {
  render: () => <FailedProviderSave initial={IssueProvider.LINEAR} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox'));
    await userEvent.click(
      await within(document.body).findByRole('option', { name: 'GitHub Issues' })
    );
    await waitFor(() => expect(canvas.getByRole('combobox')).toHaveTextContent('Linear Issues'));
    await expect(canvas.getByLabelText('API Key')).toBeInTheDocument();
    await expect(canvas.getByText('Linear', { exact: true })).toBeInTheDocument();
  },
};

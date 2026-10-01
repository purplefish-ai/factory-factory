import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { trpc } from '@/client/lib/trpc';
import { IssueProvider } from '@/shared/core/enums';
import { ProjectIssueTrackingCard } from './IssueTrackingSection';

const onSave = fn();
const onFailure = fn();
const onList = fn();

function ProviderCard() {
  const { data } = trpc.project.list.useQuery();
  const project = data?.[0];
  if (!project) {
    return <p>Loading mock project...</p>;
  }
  return (
    <ProjectIssueTrackingCard
      projectId="mock-project"
      projectName="Mock project"
      currentProvider={project.issueProvider}
      issueTrackerConfig={{
        linear: {
          hasApiKey: true,
          teamId: 'mock-team',
          teamName: 'Mock team',
          viewerName: 'Mock viewer',
        },
      }}
    />
  );
}

function FailedProviderSave({ initial }: { initial: IssueProvider }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              if (op.path === 'project.list') {
                onList();
                observer.next({
                  result: { data: [{ id: 'mock-project', issueProvider: initial }] },
                });
                observer.complete();
                return undefined;
              }
              if (op.path !== 'project.update') {
                observer.error(new TRPCClientError(`Unexpected operation: ${op.path}`));
                return undefined;
              }
              onSave(op.input);
              const timer = setTimeout(() => {
                onFailure();
                observer.error(new TRPCClientError('Mock provider save failed'));
              }, 1000);
              return () => clearTimeout(timer);
            }),
      ],
    })
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <ProviderCard />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: 'Pages/Admin/IssueProvider',
  parameters: { layout: 'padded' },
  beforeEach: () => {
    onSave.mockClear();
    onFailure.mockClear();
    onList.mockClear();
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const FailedSwitchToLinear: Story = {
  render: () => <FailedProviderSave initial={IssueProvider.GITHUB} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const provider = await canvas.findByRole('combobox');
    await userEvent.click(provider);
    await userEvent.click(
      await within(document.body).findByRole('option', { name: 'Linear Issues' })
    );
    await expect(provider).toHaveTextContent('Linear Issues');
    await expect(onSave).toHaveBeenCalledWith({
      id: 'mock-project',
      issueProvider: IssueProvider.LINEAR,
    });
    await waitFor(() => expect(onFailure).toHaveBeenCalledOnce(), { timeout: 3000 });
    await waitFor(() => expect(provider).toHaveTextContent('GitHub Issues'));
    await waitFor(() => expect(onList.mock.calls.length).toBeGreaterThanOrEqual(2));
    await expect(canvas.queryByLabelText('API Key')).not.toBeInTheDocument();
    await expect(canvas.getByText('GitHub', { exact: true })).toBeInTheDocument();
  },
};

export const FailedSwitchToGitHub: Story = {
  render: () => <FailedProviderSave initial={IssueProvider.LINEAR} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const provider = await canvas.findByRole('combobox');
    await userEvent.click(provider);
    await userEvent.click(
      await within(document.body).findByRole('option', { name: 'GitHub Issues' })
    );
    await expect(provider).toHaveTextContent('GitHub Issues');
    await expect(onSave).toHaveBeenCalledWith({
      id: 'mock-project',
      issueProvider: IssueProvider.GITHUB,
    });
    await waitFor(() => expect(onFailure).toHaveBeenCalledOnce(), { timeout: 3000 });
    await waitFor(() => expect(provider).toHaveTextContent('Linear Issues'));
    await waitFor(() => expect(onList.mock.calls.length).toBeGreaterThanOrEqual(2));
    await expect(canvas.getByLabelText('API Key')).toBeInTheDocument();
    await expect(canvas.getByText('Linear', { exact: true })).toBeInTheDocument();
  },
};

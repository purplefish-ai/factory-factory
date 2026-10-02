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
const responses: Record<string, (input: unknown) => unknown> = {
  'project.update': (input) => {
    onSave(input);
    return {};
  },
  'project.list': () => [],
};

function mockValidationResult(input: unknown) {
  const isKeyB =
    typeof input === 'object' &&
    input !== null &&
    'apiKey' in input &&
    input.apiKey === 'mock-key-b';
  const suffix = isKeyB ? 'B' : 'A';
  return {
    valid: true,
    viewerName: `Mock Viewer ${suffix}`,
    teams: [{ id: `team-${suffix}`, name: `Team ${suffix}`, key: suffix }],
  };
}

function LinearSettingsStory({
  validationDelay = 0,
  failFirstSave = false,
}: {
  validationDelay?: number;
  failFirstSave?: boolean;
}) {
  const [queryClient] = useState(() => new QueryClient());
  const [client] = useState(() => {
    let saveAttempts = 0;
    const shouldFailSave = (path: string) =>
      path === 'project.update' && failFirstSave && ++saveAttempts === 1;
    return trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              const input = op.input;
              if (shouldFailSave(op.path)) {
                const timer = setTimeout(() => {
                  observer.error(new TRPCClientError('Mock save failure; retry is safe'));
                }, 200);
                return () => clearTimeout(timer);
              }
              if (op.path === 'linear.validateKeyAndListTeams') {
                const timer = setTimeout(() => {
                  observer.next({
                    result: {
                      data: mockValidationResult(input),
                    },
                  });
                  observer.complete();
                }, validationDelay);
                return () => clearTimeout(timer);
              }
              const respond = responses[op.path];
              if (!respond) {
                observer.error(new TRPCClientError(`No story fixture for ${op.path}`));
                return undefined;
              }
              observer.next({ result: { data: respond(input) } });
              observer.complete();
              return undefined;
            }),
      ],
    });
  });
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <ProjectIssueTrackingCard
          projectId="project-1"
          projectName="Alpha"
          currentProvider={IssueProvider.LINEAR}
          issueTrackerConfig={null}
        />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: 'Pages/Admin/IssueTracking',
  parameters: { layout: 'padded' },
  beforeEach: () => onSave.mockClear(),
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const RevalidateEditedKey: Story = {
  render: () => <LinearSettingsStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const key = canvas.getByLabelText('API Key');
    await userEvent.type(key, 'mock-key-a');
    await userEvent.click(canvas.getByRole('button', { name: 'Validate' }));
    await canvas.findByText('Connected as Mock Viewer A');
    await userEvent.click(canvas.getByText('Select a team'));
    await userEvent.click(await within(document.body).findByRole('option', { name: 'Team A (A)' }));
    await userEvent.clear(key);
    await userEvent.type(key, 'mock-key-b');
    await expect(canvas.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    await expect(canvas.queryByText(/Connected as/)).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Validate' }));
    await canvas.findByText('Connected as Mock Viewer B');
    await expect(canvas.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.click(canvas.getByText('Select a team'));
    await userEvent.click(await within(document.body).findByRole('option', { name: 'Team B (B)' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        id: 'project-1',
        issueProvider: IssueProvider.LINEAR,
        issueTrackerConfig: {
          linear: {
            apiKey: 'mock-key-b',
            teamId: 'team-B',
            teamName: 'Team B (B)',
            viewerName: 'Mock Viewer B',
          },
        },
      })
    );
  },
};

export const EditDuringValidation: Story = {
  render: () => <LinearSettingsStory validationDelay={1000} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const key = canvas.getByLabelText('API Key');
    await userEvent.type(key, 'mock-key-a');
    await userEvent.click(canvas.getByRole('button', { name: 'Validate' }));
    await userEvent.clear(key);
    await userEvent.type(key, 'mock-key-b');
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Validate' })).toBeEnabled(), {
      timeout: 3000,
    });
    await expect(canvas.queryByText(/Connected as/)).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    await expect(onSave).not.toHaveBeenCalled();
  },
};

export const RetryFailedSave: Story = {
  render: () => <LinearSettingsStory failFirstSave />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const key = canvas.getByLabelText('API Key');
    await userEvent.type(key, 'mock-key-a');
    await userEvent.click(canvas.getByRole('button', { name: 'Validate' }));
    await canvas.findByText('Connected as Mock Viewer A');
    await userEvent.click(canvas.getByText('Select a team'));
    await userEvent.click(await within(document.body).findByRole('option', { name: 'Team A (A)' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Save' })).toBeEnabled());
    await expect(key).toHaveValue('mock-key-a');
    await expect(canvas.getByText('Connected as Mock Viewer A')).toBeInTheDocument();
    await expect(canvas.getByText('Team A (A)')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(key).toHaveValue(''));
    await expect(onSave).toHaveBeenCalledTimes(1);
    await expect(canvas.queryByText(/Connected as/)).not.toBeInTheDocument();
  },
};

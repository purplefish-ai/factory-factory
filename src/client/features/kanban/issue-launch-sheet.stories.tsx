import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { type ReactNode, useState } from 'react';
import { fn } from 'storybook/test';
import { trpc } from '@/client/lib/trpc';
import { IssueLaunchSheet } from './issue-launch-sheet';

function PreviewSession({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              if (op.path === 'userSettings.get') {
                observer.next({
                  result: { data: { defaultSessionProvider: 'CODEX', ratchetEnabled: false } },
                });
                observer.complete();
              }
            }),
      ],
    })
  );
  return (
    <QueryClientProvider client={queryClient}>
      <trpc.Provider client={client} queryClient={queryClient}>
        {children}
      </trpc.Provider>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Board/IssueLaunchSheet',
  component: IssueLaunchSheet,
  decorators: [
    (Story) => (
      <PreviewSession>
        <Story />
      </PreviewSession>
    ),
  ],
  args: {
    projectId: 'preview-project',
    open: true,
    onOpenChange: fn(),
    issue: {
      id: 'github-42',
      provider: 'github',
      displayId: '#42',
      title: 'Fix login redirect',
      body: 'Issue details are fetched by the agent rather than embedded in the prompt.',
      url: 'https://github.com/acme/repo/issues/42',
      author: 'octocat',
      createdAt: '2026-11-03T12:00:00.000Z',
      githubIssueNumber: 42,
    },
  },
} satisfies Meta<typeof IssueLaunchSheet>;
export default meta;
type Story = StoryObj<typeof meta>;

export const GitHub: Story = {};

export const Linear: Story = {
  args: {
    issue: {
      id: 'linear-42',
      provider: 'linear',
      displayId: 'ENG-42',
      title: 'Fix login redirect',
      body: 'Issue details are fetched by the agent rather than embedded in the prompt.',
      url: 'https://linear.app/acme/issue/ENG-42/fix-login-redirect',
      author: 'linear-user',
      createdAt: '2026-11-03T12:00:00.000Z',
      linearIssueId: 'linear-uuid-42',
      linearIssueIdentifier: 'ENG-42',
    },
  },
};

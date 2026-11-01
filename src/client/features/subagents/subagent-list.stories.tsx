import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { useState, type ReactNode } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { trpc } from '@/client/lib/trpc';
import { SubagentList } from './subagent-list';
import type { SubagentListItem } from './types';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const activeSubagents: SubagentListItem[] = [
  {
    id: 'agent-security',
    name: 'Security review',
    status: 'running',
    createdAt: minutesAgo(12),
    updatedAt: minutesAgo(1),
    completedAt: null,
    latestActivity: 'Checking authentication and permission boundaries',
    resultPreview: null,
  },
  {
    id: 'agent-tests',
    name: null,
    status: 'waiting',
    createdAt: minutesAgo(5),
    updatedAt: minutesAgo(1),
    completedAt: null,
    latestActivity: 'Waiting for the test process to finish',
    resultPreview: null,
  },
];

const completedSubagents: SubagentListItem[] = [
  {
    id: 'agent-docs',
    name: 'Documentation scan',
    status: 'completed',
    createdAt: minutesAgo(40),
    updatedAt: minutesAgo(20),
    completedAt: minutesAgo(20),
    latestActivity: null,
    resultPreview: 'Found two guides that need updated examples.',
  },
  {
    id: 'agent-build',
    name: 'Build verification',
    status: 'failed',
    createdAt: minutesAgo(30),
    updatedAt: minutesAgo(10),
    completedAt: minutesAgo(10),
    latestActivity: null,
    resultPreview: 'Storybook build stopped on a missing icon export.',
  },
];

function StopStoryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () => () =>
          observable((observer) => {
            observer.next({ result: { data: undefined } });
            observer.complete();
          }),
      ],
    })
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: 'Subagents/SubagentList',
  component: SubagentList,
  decorators: [
    (Story) => (
      <div className="h-[520px] w-[320px] overflow-y-auto border bg-background">
        <Story />
      </div>
    ),
  ],
  args: { onSelect: fn() },
} satisfies Meta<typeof SubagentList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { args: { state: { kind: 'ready', subagents: [] } } };

export const ActiveOnly: Story = {
  args: { state: { kind: 'ready', subagents: activeSubagents } },
};

export const MixedCollapsed: Story = {
  args: { state: { kind: 'ready', subagents: [...activeSubagents, ...completedSubagents] } },
};

export const MixedExpanded: Story = {
  args: { state: { kind: 'ready', subagents: [...activeSubagents, ...completedSubagents] } },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Completed · 2' }));
  },
};

export const Loading: Story = { args: { state: { kind: 'loading' } } };

export const Unsupported: Story = { args: { state: { kind: 'unsupported' } } };

export const ListError: Story = {
  args: {
    state: { kind: 'error', message: 'The provider could not list sub-agents.', onRetry: fn() },
  },
};

export const ManySimultaneousAgents: Story = {
  args: {
    state: {
      kind: 'ready',
      subagents: activeSubagents.flatMap((agent, group) =>
        Array.from({ length: 8 }, (_, index) => ({
          ...agent,
          id: `agent-${group}-${index}`,
          name: `Worker ${group * 8 + index + 1}`,
        }))
      ),
    },
  },
};

export const ControllableSubagents: Story = {
  args: {
    controlSessionId: 'live-parent',
    controlRuntimeId: 'runtime',
    state: {
      kind: 'ready',
      subagents: [
        { ...activeSubagents[0]!, stopControl: { runtimeId: 'runtime', controlId: 'native-live' } },
        activeSubagents[1]!,
        ...completedSubagents,
      ],
    },
  },
  decorators: [
    (Story) => (
      <StopStoryProvider>
        <Story />
      </StopStoryProvider>
    ),
  ],
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getAllByRole('button', { name: /^Stop subagent:/ })
    ).toHaveLength(1);
  },
};

export const SubagentStopPending: Story = {
  ...ControllableSubagents,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /^Stop subagent:/ }));
    await expect(canvas.getByRole('button', { name: /^Stop subagent:/ })).toBeDisabled();
  },
};

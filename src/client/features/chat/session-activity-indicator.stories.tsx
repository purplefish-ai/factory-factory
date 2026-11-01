import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { useState, type ReactNode } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { SubagentList } from '@/client/features/subagents';
import { trpc } from '@/client/lib/trpc';
import { SessionActivityIndicator } from './session-activity-indicator';

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

function runningList(indices: number[]) {
  return (
    <SubagentList
      activeOnly
      onSelect={fn()}
      state={{
        kind: 'ready',
        subagents: Array.from({ length: Math.max(...indices) + 1 }, (_, index) => ({
          id: `agent-${index}`,
          name: ['Review code', 'Run tests', 'Update docs'][index] ?? `Task ${index + 1}`,
          status: indices.includes(index) ? 'running' : 'completed',
          createdAt: null,
          updatedAt: null,
          completedAt: null,
          latestActivity: 'Working on the task',
          resultPreview: null,
        })),
      }}
    />
  );
}

const meta = {
  title: 'Chat/SessionActivityIndicator',
  component: SessionActivityIndicator,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="w-full max-w-md">
        <Story />
      </div>
    ),
  ],
  args: {
    work: { promptInFlight: false, backgroundTasks: [], runningSubagents: 3, activeGoals: 0 },
    runningSubagentList: runningList([0, 1, 2]),
    runningSubagentIconIndices: [0, 1, 2],
  },
} satisfies Meta<typeof SessionActivityIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ThreeSubagents: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '3 sub-agents running' }));
    await expect(canvas.getByRole('button', { name: /Review code/ })).toBeVisible();
  },
};

export const OneSubagent: Story = {
  args: {
    work: { promptInFlight: false, backgroundTasks: [], runningSubagents: 1, activeGoals: 0 },
    runningSubagentList: runningList([0]),
    runningSubagentIconIndices: [0],
  },
};

export const TwoSubagents: Story = {
  args: {
    work: { promptInFlight: false, backgroundTasks: [], runningSubagents: 2, activeGoals: 0 },
    runningSubagentList: runningList([0, 1]),
    runningSubagentIconIndices: [0, 1],
  },
};

export const Dark: Story = {
  globals: { theme: 'dark' },
};

export const ManySubagents: Story = {
  args: {
    work: { promptInFlight: false, backgroundTasks: [], runningSubagents: 12, activeGoals: 0 },
    runningSubagentList: runningList(Array.from({ length: 12 }, (_, index) => index)),
  },
};

export const WithSessionActivity: Story = {
  args: {
    work: {
      promptInFlight: true,
      backgroundTasks: [{ id: 'tests', name: 'pnpm test', kind: 'shell' }],
      runningSubagents: 3,
      activeGoals: 0,
    },
  },
};

export const SummariesUnavailable: Story = {
  args: { runningSubagentList: undefined },
};

export const AfterEarlierAgentsFinish: Story = {
  args: {
    work: { promptInFlight: false, backgroundTasks: [], runningSubagents: 2, activeGoals: 0 },
    runningSubagentIconIndices: [3, 12],
    runningSubagentList: runningList([3, 12]),
  },
};

export const SummariesLoading: Story = {
  args: { runningSubagentIconIndices: [] },
};

export const ControllableProcesses: Story = {
  args: {
    controlSessionId: 'live-parent',
    work: {
      controlRuntimeId: 'runtime',
      promptInFlight: false,
      runningSubagents: 0,
      activeGoals: 0,
      backgroundTasks: [
        {
          id: 'tests',
          name: 'pnpm test',
          kind: 'shell',
          stopControl: { runtimeId: 'runtime', controlId: 'tests-live' },
        },
        {
          id: 'preview',
          name: 'pnpm dev',
          kind: 'shell',
          stopControl: { runtimeId: 'runtime', controlId: 'preview-live' },
        },
        { id: 'monitor', name: 'Provider monitor (unsupported)', kind: 'task' },
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
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { expanded: false }));
    await expect(canvas.getAllByRole('button', { name: /^Stop process:/ })).toHaveLength(2);
  },
};

export const ProcessStopPending: Story = {
  ...ControllableProcesses,
  play: async (context) => {
    await ControllableProcesses.play?.(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getAllByRole('button', { name: /^Stop process:/ })[0]!);
    await expect(canvas.getAllByRole('button', { name: /^Stop process:/ })[0]).toBeDisabled();
  },
};

export const LaterPageFailed: Story = {
  args: {
    runningSubagentIconIndices: [],
    runningSubagentList: (
      <SubagentList
        activeOnly
        onSelect={fn()}
        state={{
          kind: 'ready',
          subagents: [],
          hasMore: true,
          error: { message: 'Some sub-agent activity could not be loaded.', onRetry: fn() },
        }}
      />
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '3 sub-agents running' }));
    await expect(canvas.getByRole('button', { name: 'Retry' })).toBeVisible();
  },
};

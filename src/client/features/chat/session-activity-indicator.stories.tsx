import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { useState, type ReactNode } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
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
    onOpenAgents: fn(),
    runningSubagentIconIndices: [0, 1, 2],
  },
} satisfies Meta<typeof SessionActivityIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ThreeSubagents: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '3 sub-agents running' }));
    await expect(args.onOpenAgents).toHaveBeenCalledOnce();
  },
};

export const OneSubagent: Story = {
  args: {
    work: { promptInFlight: false, backgroundTasks: [], runningSubagents: 1, activeGoals: 0 },
  },
};

export const TwoSubagents: Story = {
  args: {
    work: { promptInFlight: false, backgroundTasks: [], runningSubagents: 2, activeGoals: 0 },
  },
};

export const Dark: Story = {
  globals: { theme: 'dark' },
};

export const ManySubagents: Story = {
  args: {
    work: { promptInFlight: false, backgroundTasks: [], runningSubagents: 12, activeGoals: 0 },
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

export const WithoutNavigation: Story = {
  args: { onOpenAgents: undefined },
};

export const AfterEarlierAgentsFinish: Story = {
  args: {
    work: { promptInFlight: false, backgroundTasks: [], runningSubagents: 2, activeGoals: 0 },
    runningSubagentIconIndices: [3, 12],
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
    await expect(canvas.getAllByRole('button', { name: 'Stop process' })).toHaveLength(2);
  },
};

export const ProcessStopPending: Story = {
  ...ControllableProcesses,
  play: async (context) => {
    await ControllableProcesses.play?.(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getAllByRole('button', { name: 'Stop process' })[0]!);
    await expect(canvas.getAllByRole('button', { name: 'Stop process' })[0]).toBeDisabled();
  },
};

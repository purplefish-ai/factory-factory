import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import { STORY_TRPC_PENDING } from '@/client/lib/storybook-trpc';
import { type ProcessesData, ProcessesSection } from './ProcessesSection';

type AgentProcess = ProcessesData['agent'][number];

const agent: AgentProcess = {
  sessionId: 'session-alpha-1',
  name: 'Fix flaky test',
  workspaceId: 'workspace-alpha',
  workspaceName: 'alpha',
  workspaceBranch: 'martin/fix-flaky-test',
  projectSlug: 'factory-factory',
  workflow: 'default',
  model: 'opus',
  status: 'RUNNING',
  memoryStatus: null,
  pid: 4242,
  cpuPercent: 3.2,
  memoryBytes: 268_435_456,
  idleTimeMs: 12_000,
  inMemory: true,
  createdAt: new Date('2026-11-09T09:00:00Z'),
  updatedAt: new Date('2026-11-09T09:05:00Z'),
};

const processes = {
  agent: [agent],
  terminal: [],
  summary: { totalAgent: 1, totalTerminal: 0, total: 1 },
} satisfies ProcessesData;

const meta = {
  title: 'Settings/ProcessesSection',
  component: ProcessesSection,
  parameters: {
    layout: 'padded',
    trpc: {
      handlers: {
        'session.getMaxSessionsPerWorkspace': () => 5,
        'admin.stopSession': () => STORY_TRPC_PENDING,
      },
    },
  },
} satisfies Meta<typeof ProcessesSection>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NoProcesses: Story = {
  args: {
    processes: { agent: [], terminal: [], summary: { totalAgent: 0, totalTerminal: 0, total: 0 } },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('No active processes')).toBeVisible();
  },
};

export const StoppingSession: Story = {
  args: { processes },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Stop session' }));
    const stopping = await canvas.findByRole('button', { name: 'Stopping session…' });
    await expect(stopping).toBeDisabled();
    // The spinner replaces the stop icon; the button's title names the state.
    await expect(stopping.querySelector('.animate-spin')).not.toBeNull();
  },
};

export const StoppingSessionPhone: Story = {
  ...StoppingSession,
  globals: { viewport: { value: 'phone', isRotated: false } },
};

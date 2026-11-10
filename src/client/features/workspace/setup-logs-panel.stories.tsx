import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { SetupLogsPanel } from './setup-logs-panel';

const fullLog = [
  '$ pnpm install',
  'Lockfile is up to date, resolution step is skipped',
  'Packages: +1204',
  'Done in 8.2s',
  '$ pnpm db:migrate',
  'All migrations have been applied.',
].join('\n');

const failedTail = [
  '[...truncated...]',
  'Packages: +1204',
  '$ pnpm db:migrate',
  'Error: P1001: Can’t reach database server',
  'Startup script exited with code 1',
].join('\n');

function initStatus(status: string, initOutput: string | null) {
  return { trpc: { handlers: { 'workspace.getInitStatus': () => ({ status, initOutput }) } } };
}

const meta = {
  title: 'Workspace/SetupLogsPanel',
  component: SetupLogsPanel,
  args: { workspaceId: 'setup-logs-story', className: 'h-80' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof SetupLogsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {
  parameters: initStatus('PROVISIONING', '$ pnpm install\nProgress: resolved 812, reused 790'),
};

export const Ready: Story = { parameters: initStatus('READY', fullLog) };

export const Failed: Story = {
  parameters: initStatus('FAILED', `${fullLog}\nStartup script exited with code 1`),
};

export const NoLogsYet: Story = { parameters: initStatus('NEW', null) };

export const ArchivedLogNotKept: Story = {
  parameters: initStatus('ARCHIVED', null),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Setup logs are not kept for archived workspaces.')
    ).toBeInTheDocument();
  },
};

export const ArchivedFailedSetupTail: Story = {
  parameters: initStatus('ARCHIVED', failedTail),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Archived workspaces keep only the end of a failed setup log.')
    ).toBeInTheDocument();
    await expect(canvas.getByText(/Startup script exited with code 1/)).toBeInTheDocument();
  },
};

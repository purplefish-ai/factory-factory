import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { ApplicationUpdates } from '@/shared/application-updates';
import { FactoryUpdateBannerContent } from './factory-update-banner';

const updates: ApplicationUpdates = {
  currentVersion: '0.5.3',
  automaticUpdate: true,
  manualCommand: 'npm install -g factory-factory@0.5.4',
  status: { phase: 'idle' },
  notices: [
    {
      id: 'factory-factory',
      label: 'Factory Factory',
      currentVersion: '0.5.3',
      latestVersion: '0.5.4',
    },
    { id: 'claude', label: 'Claude', currentVersion: '0.3.315', latestVersion: '0.3.316' },
    { id: 'codex', label: 'Codex', currentVersion: '2.4.0', latestVersion: '2.5.0' },
  ],
};

const callbacks = { onUpdate: fn(), onCancel: fn(), onDismiss: fn() };

const meta = {
  title: 'Shared/FactoryUpdateBanner',
  component: FactoryUpdateBannerContent,
  parameters: { layout: 'fullscreen' },
  args: { updates, ...callbacks },
  beforeEach: () => {
    callbacks.onUpdate.mockClear();
    callbacks.onCancel.mockClear();
    callbacks.onDismiss.mockClear();
  },
} satisfies Meta<typeof FactoryUpdateBannerContent>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SimultaneousUpdates: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('listitem')).toHaveLength(3);
    await expect(canvas.getAllByRole('button', { name: /^Update$/ })).toHaveLength(1);
    await userEvent.click(canvas.getByRole('button', { name: /^Update$/ }));
    await expect(args.onUpdate).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole('button', { name: 'Dismiss Claude update' }));
    await expect(args.onDismiss).toHaveBeenCalledWith('claude', '0.3.316');
  },
};
export const Waiting: Story = {
  args: { updates: { ...updates, status: { phase: 'waiting', targetVersion: '0.5.4' } } },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(
      'Waiting for active agent work to finish before updating.'
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Cancel update' }));
    await expect(args.onCancel).toHaveBeenCalledOnce();
  },
};
export const Preparing: Story = {
  args: { updates: { ...updates, status: { phase: 'preparing', targetVersion: '0.5.4' } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(
      'Preparing the update. Factory Factory will restart shortly.'
    );
    await expect(canvas.getByRole('button', { name: 'Updating…' })).toBeDisabled();
  },
};
export const Restarting: Story = {
  args: { updates: { ...updates, status: { phase: 'restarting', targetVersion: '0.5.4' } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(
      'Restarting Factory Factory. Reconnecting automatically…'
    );
    await expect(canvas.getByRole('button', { name: 'Restarting…' })).toBeDisabled();
  },
};
export const Failed: Story = {
  args: {
    updates: {
      ...updates,
      status: {
        phase: 'failed',
        targetVersion: '0.5.4',
        error: 'Could not install the update. Your current installation is still available.',
      },
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('Could not install');
    await userEvent.click(canvas.getByRole('button', { name: 'Retry update' }));
    await expect(args.onUpdate).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole('button', { name: 'Dismiss update error' }));
    await expect(args.onDismiss).toHaveBeenCalledWith('update-error', '0.5.4');
  },
};
export const ManualInstallation: Story = {
  args: { updates: { ...updates, automaticUpdate: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: /^Update$/ })).not.toBeInTheDocument();
    await expect(canvas.getByText('npm install -g factory-factory@0.5.4')).toBeInTheDocument();
  },
};
export const RequestPending: Story = { args: { isPending: true } };
export const NoUpdates: Story = { args: { updates: { ...updates, notices: [] } } };
export const SimultaneousUpdatesDark: Story = { globals: { theme: 'dark' } };
export const Phone: Story = { globals: { viewport: { value: 'phone', isRotated: false } } };
export const DismissIndependently: Story = {
  render: (args) => {
    const [notices, setNotices] = useState(args.updates.notices);
    return (
      <FactoryUpdateBannerContent
        {...args}
        updates={{ ...args.updates, notices }}
        onDismiss={(id) => setNotices((previous) => previous.filter((notice) => notice.id !== id))}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Dismiss Claude update' }));
    await expect(canvas.getAllByRole('listitem')).toHaveLength(2);
    await expect(canvas.queryByText(/Claude update available/)).not.toBeInTheDocument();
    await expect(canvas.getByText(/Codex update available/)).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /^Update$/ })).toBeEnabled();
  },
};

export const RecoveryFailureWithoutNotices: Story = {
  args: {
    updates: {
      ...updates,
      notices: [],
      status: {
        phase: 'failed',
        targetVersion: '0.5.4',
        error: 'The replacement could not start. The previous installation is available.',
      },
    },
  },
  render: (args) => {
    const [status, setStatus] = useState(args.updates.status);
    return (
      <FactoryUpdateBannerContent
        {...args}
        updates={{ ...args.updates, status }}
        onDismiss={(id, version) => {
          args.onDismiss(id, version);
          setStatus({ phase: 'idle' });
        }}
      />
    );
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('The replacement could not start.');
    await expect(canvas.queryByRole('listitem')).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Retry update' }));
    await expect(args.onUpdate).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole('button', { name: 'Dismiss update error' }));
    await expect(args.onDismiss).toHaveBeenCalledWith('update-error', '0.5.4');
    await expect(
      canvas.queryByRole('region', { name: 'Application updates' })
    ).not.toBeInTheDocument();
  },
};

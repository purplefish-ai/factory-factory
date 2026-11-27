import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ConnectionBannerContent } from './connection-banner';

const onReload = fn();

const meta = {
  title: 'Shared/ConnectionBanner',
  component: ConnectionBannerContent,
  parameters: { layout: 'fullscreen' },
  args: { state: 'reconnecting', onReload },
  beforeEach: () => {
    onReload.mockClear();
  },
} satisfies Meta<typeof ConnectionBannerContent>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Reconnecting: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('connection-banner-reconnecting')).toHaveTextContent(
      'Connection lost. Reconnecting…'
    );
    await expect(canvas.queryByRole('button')).not.toBeInTheDocument();
  },
};

export const ReconnectingDark: Story = { ...Reconnecting, globals: { theme: 'dark' } };

export const NotResponding: Story = {
  args: { state: 'unresponsive' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const banner = canvas.getByTestId('connection-banner-reconnecting');
    await expect(banner).toHaveTextContent(
      "Factory Factory isn't responding. Waiting for a reply…"
    );
    await expect(banner).toHaveAttribute('data-state', 'unresponsive');
  },
};

export const ReloadToUpdate: Story = {
  args: { state: 'outdated' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Factory Factory has been updated.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Reload to update' }));
    await expect(args.onReload).toHaveBeenCalledOnce();
  },
};

export const ReloadToUpdateDark: Story = {
  args: { state: 'outdated' },
  globals: { theme: 'dark' },
};

export const Phone: Story = {
  args: { state: 'outdated' },
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const Connected: Story = {
  args: { state: null },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-slot="status-callout"]')).toBeNull();
  },
};

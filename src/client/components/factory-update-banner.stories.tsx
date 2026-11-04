import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import { FactoryUpdateBanner } from './factory-update-banner';

const meta = {
  title: 'Shared/FactoryUpdateBanner',
  component: FactoryUpdateBanner,
  parameters: {
    layout: 'fullscreen',
    trpc: {
      handlers: {
        'admin.checkFactoryUpdate': () => ({
          currentVersion: '0.5.3',
          latestVersion: '0.6.0',
          updateAvailable: true,
        }),
      },
    },
  },
  beforeEach: () => {
    localStorage.removeItem('ff_dismissed_factory_release');
  },
} satisfies Meta<typeof FactoryUpdateBanner>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Available: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('status')).toHaveTextContent('0.6.0');
    await expect(canvas.getByRole('link', { name: 'View upgrade instructions' })).toHaveAttribute(
      'href',
      'https://github.com/purplefish-ai/factory-factory#updating'
    );
  },
};
export const Dismissed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Dismiss update notification' })
    );
    await expect(canvas.queryByRole('status')).not.toBeInTheDocument();
  },
};
export const Dark: Story = { globals: { theme: 'dark' } };
export const Phone: Story = { globals: { viewport: { value: 'phone', isRotated: false } } };
export const Current: Story = {
  parameters: {
    trpc: {
      handlers: {
        'admin.checkFactoryUpdate': () => ({
          currentVersion: '0.6.0',
          latestVersion: '0.6.0',
          updateAvailable: false,
        }),
      },
    },
  },
};
export const RegistryUnavailable: Story = {
  parameters: {
    trpc: {
      handlers: {
        'admin.checkFactoryUpdate': () => ({
          currentVersion: '0.5.3',
          latestVersion: null,
          updateAvailable: false,
        }),
      },
    },
  },
};
export const Loading: Story = {
  parameters: {
    trpc: {
      handlers: {
        'admin.checkFactoryUpdate': () =>
          new Promise(() => {
            /* Keep the update check pending. */
          }),
      },
    },
  },
};

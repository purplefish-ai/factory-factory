import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import { HostLoadIndicatorView } from './host-load-indicator';
import { hostLoadHistory as history } from './host-load.story-fixtures';

const meta: Meta<typeof HostLoadIndicatorView> = {
  title: 'Navigation/HostLoadIndicator',
  component: HostLoadIndicatorView,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  args: { samples: history(18, 45), compact: false },
};
export default meta;
type Story = StoryObj<typeof meta>;

export const Calm: Story = {};

export const JustStarted: Story = { args: { samples: history(18, 45, 2) } };

export const BusyCpu: Story = { args: { samples: history(86, 45) } };

export const MemoryExhausted: Story = { args: { samples: history(30, 97) } };

export const Details: Story = {
  args: { samples: history(86, 45) },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Computer load/ }));
    const body = within(canvasElement.ownerDocument.body);
    await expect(await body.findByText('Memory')).toBeInTheDocument();
  },
};

export const Phone: Story = {
  args: { compact: true },
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const PhoneOverloaded: Story = {
  args: { compact: true, samples: history(30, 97) },
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const PhoneDetails: Story = {
  args: { compact: true, samples: history(86, 45) },
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: Details.play,
};

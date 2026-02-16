import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { ApiUsageSection } from './ApiUsageSection';

const meta = {
  title: 'Pages/Admin/ApiUsageSection',
  component: ApiUsageSection,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-5xl">
        <Story />
      </div>
    ),
  ],
  args: {
    onReset: fn(),
    isResetting: false,
  },
} satisfies Meta<typeof ApiUsageSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NormalTraffic: Story = {
  args: {
    apiUsage: {
      requestsLastMinute: 14,
      requestsLastHour: 391,
      totalRequests: 12_842,
      queueDepth: 1,
      isRateLimited: false,
    },
  },
};

export const RateLimited: Story = {
  args: {
    apiUsage: {
      requestsLastMinute: 120,
      requestsLastHour: 4200,
      totalRequests: 245_001,
      queueDepth: 6,
      isRateLimited: true,
    },
  },
};

export const QueueBacklog: Story = {
  args: {
    apiUsage: {
      requestsLastMinute: 33,
      requestsLastHour: 900,
      totalRequests: 86_200,
      queueDepth: 19,
      isRateLimited: false,
    },
  },
};

export const Resetting: Story = {
  args: {
    isResetting: true,
    apiUsage: {
      requestsLastMinute: 0,
      requestsLastHour: 0,
      totalRequests: 0,
      queueDepth: 0,
      isRateLimited: false,
    },
  },
};

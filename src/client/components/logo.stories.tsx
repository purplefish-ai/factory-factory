import type { Meta, StoryObj } from '@storybook/react';
import type React from 'react';
import { Logo } from './logo';

const meta = {
  title: 'Components/Logo',
  component: Logo,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    showText: {
      control: 'boolean',
    },
    iconClassName: {
      control: 'text',
    },
    textClassName: {
      control: 'text',
    },
  },
} satisfies Meta<typeof Logo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    showText: true,
  },
};

export const IconOnly: Story = {
  args: {
    showText: false,
  },
};

export const LargeIcon: Story = {
  args: {
    showText: true,
    iconClassName: 'size-12',
    textClassName: 'text-xl',
  },
};

export const OnDarkBackground: Story = {
  args: {
    showText: true,
  },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className="bg-slate-900 p-8 rounded-lg">
        <div className="text-white">
          <Story />
        </div>
      </div>
    ),
  ],
};

import type { Meta, StoryObj } from '@storybook/react';
import type React from 'react';
import { Logo, LogoIcon, LogoText } from './logo';

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
  globals: { theme: 'dark' },
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

export const IconSizes: Story = {
  render: () => (
    <div className="flex items-end gap-6">
      <LogoIcon className="size-4" />
      <LogoIcon className="size-6" />
      <LogoIcon className="size-8" />
      <LogoIcon className="size-12" />
      <LogoIcon className="size-24" />
    </div>
  ),
};

export const OnLightBackground: Story = {
  globals: { theme: 'light' },
  args: { showText: false, iconClassName: 'size-24' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className="bg-white p-8">
        <Story />
      </div>
    ),
  ],
};

export const Wordmark: Story = {
  render: () => <LogoText className="text-6xl" />,
};

export const SidebarLockup: Story = {
  args: { iconClassName: 'size-8', textClassName: 'text-base' },
};

export const StackedLockup: Story = {
  args: {
    iconClassName: 'size-16',
    textClassName: 'text-2xl',
    className: 'flex-col gap-3',
  },
};

import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from 'next-themes';
import { ThemeToggle } from './theme-toggle';

const meta = {
  title: 'Common/ThemeToggle',
  component: ThemeToggle,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <div className="p-4">
          <Story />
        </div>
      </ThemeProvider>
    ),
  ],
} satisfies Meta<typeof ThemeToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithLabel: Story = {
  decorators: [
    (Story) => (
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Theme:</span>
          <Story />
        </div>
      </ThemeProvider>
    ),
  ],
};

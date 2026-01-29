import type { Meta, StoryObj } from '@storybook/react';
import { Button } from '@/components/ui/button';
import { PageHeader } from './page-header';

const meta = {
  title: 'Common/PageHeader',
  component: PageHeader,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-full max-w-4xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PageHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TitleOnly: Story = {
  args: {
    title: 'Workspaces',
  },
};

export const WithDescription: Story = {
  args: {
    title: 'Workspaces',
    description: 'Manage your coding workspaces and sessions',
  },
};

export const WithActions: Story = {
  args: {
    title: 'Projects',
    description: 'Your connected repositories',
    children: (
      <>
        <Button variant="outline">Settings</Button>
        <Button>New Project</Button>
      </>
    ),
  },
};

export const LongTitle: Story = {
  args: {
    title: 'Authentication and Authorization Settings',
    description: 'Configure OAuth providers, API keys, and access control',
    children: <Button>Save Changes</Button>,
  },
};

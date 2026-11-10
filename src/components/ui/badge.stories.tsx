import type { Meta, StoryObj } from '@storybook/react';
import { Badge } from './badge';

const meta = {
  title: 'UI/Badge',
  component: Badge,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: [
        'default',
        'secondary',
        'destructive',
        'outline',
        'success',
        'warning',
        'info',
        'danger',
      ],
    },
    size: { control: 'select', options: ['default', 'count'] },
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'Badge',
  },
};

export const Secondary: Story = {
  args: {
    variant: 'secondary',
    children: 'Secondary',
  },
};

export const Destructive: Story = {
  args: {
    variant: 'destructive',
    children: 'Destructive',
  },
};

export const Outline: Story = {
  args: {
    variant: 'outline',
    children: 'Outline',
  },
};

export const Success: Story = {
  args: {
    variant: 'success',
    children: 'Success',
  },
};

export const Warning: Story = {
  args: {
    variant: 'warning',
    children: 'Warning',
  },
};

export const Info: Story = {
  args: {
    variant: 'info',
    children: 'Info',
  },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Badge>Default</Badge>
      <Badge variant="secondary">Secondary</Badge>
      <Badge variant="destructive">Destructive</Badge>
      <Badge variant="outline">Outline</Badge>
      <Badge variant="success">Success</Badge>
      <Badge variant="warning">Warning</Badge>
      <Badge variant="info">Info</Badge>
      <Badge variant="danger">Danger</Badge>
    </div>
  ),
};

/** Counts beside navigation items, tabs and column headings. */
export const Counts: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Badge variant="secondary" size="count">
        4
      </Badge>
      <Badge variant="warning" size="count">
        12
      </Badge>
      <Badge variant="danger" size="count">
        3
      </Badge>
      <Badge variant="outline" size="count">
        128
      </Badge>
    </div>
  ),
};

export const CountsDark: Story = { ...Counts, globals: { theme: 'dark' } };

/** Status variants are tinted: the token is the text color on a 10% tint. */
export const AllVariantsDark: Story = {
  ...AllVariants,
  globals: { theme: 'dark' },
};

/** Linked status badges keep their accent tint and underline on hover. */
export const LinkedStatusVariants: Story = {
  render: () => (
    <div className="flex gap-3">
      {(['success', 'warning', 'info'] as const).map((variant) => (
        <Badge key={variant} variant={variant} asChild>
          <a href="#badge-preview">{variant}</a>
        </Badge>
      ))}
    </div>
  ),
};
export const LinkedStatusVariantsDark: Story = {
  ...LinkedStatusVariants,
  globals: { theme: 'dark' },
};

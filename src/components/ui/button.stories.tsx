import { FloppyDiskIcon } from '@phosphor-icons/react/dist/csr/FloppyDisk';
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { Button } from './button';

const meta = {
  title: 'UI/Button',
  component: Button,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'],
    },
    size: {
      control: 'select',
      options: ['default', 'xs', 'sm', 'lg', 'icon', 'icon-xs', 'icon-sm', 'icon-lg'],
    },
    disabled: {
      control: 'boolean',
    },
    pending: {
      control: 'boolean',
    },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'Button',
  },
};

export const Destructive: Story = {
  args: {
    variant: 'destructive',
    children: 'Delete',
  },
};

export const Outline: Story = {
  args: {
    variant: 'outline',
    children: 'Outline',
  },
};

export const Secondary: Story = {
  args: {
    variant: 'secondary',
    children: 'Secondary',
  },
};

export const Ghost: Story = {
  args: {
    variant: 'ghost',
    children: 'Ghost',
  },
};

export const Link: Story = {
  args: {
    variant: 'link',
    children: 'Link',
  },
};

export const Small: Story = {
  args: {
    size: 'sm',
    children: 'Small',
  },
};

export const Large: Story = {
  args: {
    size: 'lg',
    children: 'Large',
  },
};

export const Icon: Story = {
  args: {
    size: 'icon',
    children: '+',
  },
};

export const Disabled: Story = {
  args: {
    children: 'Disabled',
    disabled: true,
  },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Button variant="default">Default</Button>
      <Button variant="destructive">Destructive</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="link">Link</Button>
    </div>
  ),
};

export const AllSizes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Button size="xs">Extra small</Button>
      <Button size="sm">Small</Button>
      <Button size="default">Default</Button>
      <Button size="lg">Large</Button>
      <Button size="icon-xs" aria-label="Add, extra small">
        +
      </Button>
      <Button size="icon-sm" aria-label="Add, small">
        +
      </Button>
      <Button size="icon" aria-label="Add">
        +
      </Button>
      <Button size="icon-lg" aria-label="Add, large">
        +
      </Button>
    </div>
  ),
};

export const Pending: Story = {
  args: {
    children: 'Save',
    pending: true,
    pendingLabel: 'Saving…',
  },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Saving…' });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('aria-busy', 'true');
  },
};

/**
 * Every size while pending: the spinner replaces the static icon and takes the
 * button's icon size; labels stay beside it.
 */
export const PendingSizes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Button size="xs" pending>
        <FloppyDiskIcon />
        Save
      </Button>
      <Button size="sm" variant="outline" pending>
        <FloppyDiskIcon />
        Save
      </Button>
      <Button pending pendingLabel="Saving…">
        <FloppyDiskIcon />
        Save
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label="Start dev server" pending>
        <PlayIcon />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Start dev server"
        pending
        pendingLabel="Starting dev server"
      >
        <PlayIcon />
      </Button>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [xs, sm] = canvas.getAllByRole('button', { name: 'Save' });
    for (const button of [xs, sm]) {
      const [spinner, icon] = button?.querySelectorAll('svg') ?? [];
      await expect(spinner).toHaveAttribute('data-slot', 'spinner');
      await expect(icon).not.toBeVisible();
    }
    // The spinner follows the button's icon size: 12px in xs, 16px otherwise.
    await expect(xs?.querySelector('[data-slot=spinner]')?.getBoundingClientRect().width).toBe(12);
    await expect(sm?.querySelector('[data-slot=spinner]')?.getBoundingClientRect().width).toBe(16);
    const iconButton = canvas.getByRole('button', { name: 'Starting dev server' });
    await expect(iconButton).toBeDisabled();
    await expect(iconButton.querySelector('svg:not([data-slot=spinner])')).not.toBeVisible();
  },
};

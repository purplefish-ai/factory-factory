import { FloppyDiskIcon } from '@phosphor-icons/react/dist/csr/FloppyDisk';
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play';
import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
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
      options: [
        'default',
        'xs',
        'compact',
        'sm',
        'lg',
        'inline',
        'icon',
        'icon-xs',
        'icon-compact',
        'icon-sm',
        'icon-lg',
      ],
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

const TEXT_SIZES = [
  { size: 'xs', label: 'Extra small' },
  { size: 'compact', label: 'Compact' },
  { size: 'sm', label: 'Small' },
  { size: 'default', label: 'Default' },
  { size: 'lg', label: 'Large' },
] as const;

const ICON_SIZES = [
  { size: 'icon-xs', label: 'Add, extra small' },
  { size: 'icon-compact', label: 'Add, compact' },
  { size: 'icon-sm', label: 'Add, small' },
  { size: 'icon', label: 'Add' },
  { size: 'icon-lg', label: 'Add, large' },
] as const;

// Height and icon width per size, in the order above.
const EXPECTED_SIZES = [
  { height: 24, icon: 12 },
  { height: 28, icon: 14 },
  { height: 32, icon: 16 },
  { height: 36, icon: 16 },
  { height: 40, icon: 16 },
];

function measure(button: HTMLElement) {
  return {
    height: button.getBoundingClientRect().height,
    icon: button.querySelector('svg')?.getBoundingClientRect().width,
  };
}

/**
 * The size variant sets the button's height and its icon size; icons carry no
 * size classes. Heights are 24, 28, 32, 36 and 40px; icons are 12px in `xs`,
 * 14px in `compact` and 16px from `sm` up.
 */
export const AllSizes: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        {TEXT_SIZES.map(({ size, label }) => (
          <Button key={size} size={size} variant="outline">
            <PlayIcon />
            {label}
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-4">
        {ICON_SIZES.map(({ size, label }) => (
          <Button key={size} size={size} variant="outline" aria-label={label}>
            <PlusIcon />
          </Button>
        ))}
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const [index, { label }] of TEXT_SIZES.entries()) {
      await expect(measure(canvas.getByRole('button', { name: label }))).toEqual(
        EXPECTED_SIZES[index]
      );
    }
    for (const [index, { label }] of ICON_SIZES.entries()) {
      const button = canvas.getByRole('button', { name: label });
      await expect(measure(button)).toEqual(EXPECTED_SIZES[index]);
      await expect(button.getBoundingClientRect().width).toBe(EXPECTED_SIZES[index]?.height);
    }
  },
};

/** A `size-*` class on an icon is the opt-out for a deliberate exception. */
export const IconSizeOverride: Story = {
  render: () => (
    <Button size="sm" variant="outline">
      <PlayIcon className="size-3" />
      Run
    </Button>
  ),
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Run' });
    await expect(button.querySelector('svg')?.getBoundingClientRect().width).toBe(12);
  },
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

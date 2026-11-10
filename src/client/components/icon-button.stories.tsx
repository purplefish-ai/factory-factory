import { DotsThreeIcon } from '@phosphor-icons/react/dist/csr/DotsThree';
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { IconButton } from './icon-button';

const meta = {
  title: 'Shared/IconButton',
  component: IconButton,
  parameters: { layout: 'centered' },
  args: { label: 'Close panel', children: <XIcon /> },
} satisfies Meta<typeof IconButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The label is the accessible name and opens as the tooltip on hover or focus. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Close panel' });
    await userEvent.hover(button);
    await expect(await within(document.body).findByRole('tooltip')).toHaveTextContent(
      'Close panel'
    );
  },
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <IconButton label="Close, extra small" size="icon-xs">
        <XIcon />
      </IconButton>
      <IconButton label="Close, compact" size="icon-compact">
        <XIcon />
      </IconButton>
      <IconButton label="Close, small" size="icon-sm">
        <XIcon />
      </IconButton>
      <IconButton label="Close">
        <XIcon />
      </IconButton>
      <IconButton label="Close, large" size="icon-lg" variant="outline">
        <XIcon />
      </IconButton>
    </div>
  ),
};

/** Richer tooltip content, such as a shortcut, keeps the plain label as the name. */
export const ShortcutTooltip: Story = {
  args: {
    label: 'Run script',
    tooltip: (
      <span className="flex items-center gap-2">
        Run script <Kbd>⌘R</Kbd>
      </span>
    ),
    children: <PlayIcon />,
  },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Run script' });
    button.focus();
    await expect(await within(document.body).findByRole('tooltip')).toHaveTextContent('⌘R');
  },
};

export const Pending: Story = {
  args: {
    label: 'Run script',
    pending: true,
    pendingLabel: 'Starting script',
    children: <PlayIcon />,
  },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Starting script' });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('aria-busy', 'true');
  },
};

/** Inside `DropdownMenuTrigger asChild` the button keeps its tooltip and opens the menu. */
export const MenuTrigger: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="More actions" size="icon-sm">
          <DotsThreeIcon />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Rename</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'More actions' });
    await userEvent.click(trigger);
    await expect(
      await within(document.body).findByRole('menuitem', { name: 'Rename' })
    ).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  },
};

import { CameraIcon } from '@phosphor-icons/react/dist/csr/Camera';
import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { GitPullRequestIcon } from '@phosphor-icons/react/dist/csr/GitPullRequest';
import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { TreeStructureIcon } from '@phosphor-icons/react/dist/csr/TreeStructure';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { EmptyState } from './empty-state';

const onTakeScreenshots = fn();

const meta = {
  title: 'Shared/EmptyState',
  component: EmptyState,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  args: {
    icon: CameraIcon,
    title: 'No screenshots yet',
    description: 'Capture screenshots of the running dev app.',
  },
  decorators: [
    (Story) => (
      <div className="h-[320px] w-[420px] max-w-full rounded-md border bg-background">
        <Story />
      </div>
    ),
  ],
  beforeEach: () => {
    onTakeScreenshots.mockReset();
  },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Pair the empty state with the action that fills it. */
export const WithAction: Story = {
  args: {
    className: 'h-full',
    action: (
      <Button variant="outline" size="sm" onClick={onTakeScreenshots}>
        <CameraIcon aria-hidden="true" />
        Take screenshots
      </Button>
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('No screenshots yet')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Take screenshots' }));
    await expect(onTakeScreenshots).toHaveBeenCalledOnce();
  },
};

export const WithActionDark: Story = {
  ...WithAction,
  globals: { theme: 'dark' },
};

/** Without a next step, the title and description explain the state. */
export const TitleAndDescription: Story = {
  args: {
    icon: FileCodeIcon,
    title: 'No changes',
    description: 'The working tree is clean and up to date.',
    className: 'h-full',
  },
};

export const TitleOnly: Story = {
  args: {
    icon: undefined,
    title: 'No diff available',
    description: undefined,
    className: 'h-full',
  },
};

/** Compact size for narrow side panels and lists. */
export const Compact: Story = {
  args: {
    size: 'compact',
    icon: TreeStructureIcon,
    title: 'No child workspaces yet',
    description: undefined,
    className: 'h-full',
    action: (
      <Button variant="outline" size="sm">
        <PlusIcon aria-hidden="true" />
        New child workspace
      </Button>
    ),
  },
  decorators: [
    (Story) => (
      <div className="h-[260px] w-[280px]">
        <Story />
      </div>
    ),
  ],
};

export const CompactDark: Story = {
  ...Compact,
  globals: { theme: 'dark' },
};

/** A cautionary empty state recolors its icon with a status token. */
export const Cautionary: Story = {
  args: {
    size: 'compact',
    icon: WarningCircleIcon,
    iconClassName: 'text-warning',
    title: 'No common history with main',
    description: "This branch doesn't share history with the main branch.",
    className: 'h-full',
  },
};

/** Extra content such as keyboard hints goes in children. */
export const WithHint: Story = {
  args: {
    icon: GitPullRequestIcon,
    title: 'No PR selected',
    description: undefined,
    className: 'h-full',
    children: (
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Kbd>j</Kbd>
        <Kbd>k</Kbd>
        <span>to navigate</span>
      </div>
    ),
  },
};

export const Phone: Story = {
  ...WithAction,
  globals: { viewport: { value: 'phone', isRotated: false } },
  decorators: [
    (Story) => (
      <div className="h-[320px] w-full">
        <Story />
      </div>
    ),
  ],
};

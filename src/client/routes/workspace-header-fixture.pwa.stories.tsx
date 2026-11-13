import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { WorkspaceToolsDrawer } from '@/client/components/workspace-tools-drawer';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { WorkspaceHeaderFixture } from './workspace-header-fixture';
import { workspaceHeaderMeta } from './workspace-header-fixture.story-fixtures';
import { WorkspaceHeaderPwaPreview } from './workspace-header-pwa-preview';

const meta = {
  ...workspaceHeaderMeta,
  title: 'Navigation/AppHeader',
} satisfies Meta<typeof WorkspaceHeaderFixture>;
export default meta;
type Story = StoryObj<typeof meta>;

const expectDividerBelowNativeControls: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const header = canvasElement.querySelector('header')!;
  const controls = header.querySelector('.app-header-controls')!;
  const bounds = header.getBoundingClientRect();
  const styles = getComputedStyle(header);
  const border = Number.parseFloat(styles.borderBottomWidth);
  await expect(border).toBe(1);
  await expect(bounds.bottom - border).toBeGreaterThanOrEqual(bounds.top + 32);
  await expect(bounds.bottom - border).toBe(controls.getBoundingClientRect().bottom);
  await expect(getComputedStyle(header, '::after').content).toBe('none');
};

export const InstalledPwaControlsLeft: Story = {
  play: expectDividerBelowNativeControls,
  globals: { theme: 'dark' },
  decorators: [
    (Story) => (
      <WorkspaceHeaderPwaPreview side="left">
        <Story />
      </WorkspaceHeaderPwaPreview>
    ),
  ],
};
export const InstalledPwaControlsRight: Story = {
  play: expectDividerBelowNativeControls,
  globals: { theme: 'dark' },
  decorators: [
    (Story) => (
      <WorkspaceHeaderPwaPreview side="right">
        <Story />
      </WorkspaceHeaderPwaPreview>
    ),
  ],
};
export const InstalledPwaLight: Story = {
  globals: { theme: 'light' },
  decorators: InstalledPwaControlsLeft.decorators,
  play: expectDividerBelowNativeControls,
};
export const InstalledPwaLargeText: Story = {
  play: expectDividerBelowNativeControls,
  args: { variant: 'family' },
  globals: { theme: 'dark' },
  decorators: [
    (Story) => (
      <WorkspaceHeaderPwaPreview side="right" fontScale={150}>
        <Story />
      </WorkspaceHeaderPwaPreview>
    ),
  ],
};

// Exercise the real header triggers, including the sideways sidebar tooltip.
export const InstalledPwaHeaderTooltips: Story = {
  decorators: InstalledPwaControlsRight.decorators,
  play: async ({ canvas, canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    for (const name of ['Toggle sidebar', 'Hide right panel']) {
      const trigger = canvas.getByRole('button', { name });
      await userEvent.hover(trigger);
      const tooltip = await body.findByRole('tooltip', {
        name: name === 'Toggle sidebar' ? /^Toggle sidebar/ : name,
      });
      await waitFor(async () => {
        const content = tooltip.closest('[data-slot="tooltip-content"]');
        await expect(content).not.toBeNull();
        await expect(content!.getBoundingClientRect().top).toBeGreaterThanOrEqual(32);
      });
      await userEvent.unhover(trigger);
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(body.queryByRole('tooltip')).toBeNull());
    }
  },
};

export const InstalledPwaHeaderTooltipsLeft: Story = {
  decorators: InstalledPwaControlsLeft.decorators,
  play: InstalledPwaHeaderTooltips.play,
};

export const InstalledPwaContentTooltip: Story = {
  decorators: InstalledPwaControlsRight.decorators,
  render: () => (
    <>
      <WorkspaceHeaderFixture />
      <div className="absolute top-12 right-5">
        <Tooltip defaultOpen>
          <TooltipTrigger asChild>
            <Button variant="outline">Archive All</Button>
          </TooltipTrigger>
          <TooltipContent>Archive all workspaces in this column</TooltipContent>
        </Tooltip>
      </div>
    </>
  ),
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const tooltip = await body.findByRole('tooltip');
    await waitFor(async () => {
      const content = tooltip.closest('[data-slot="tooltip-content"]');
      await expect(content!.getBoundingClientRect().top).toBeGreaterThanOrEqual(32);
      await expect(content).toHaveAttribute('data-side', 'bottom');
    });
  },
};

export const InstalledPwaSearch: Story = {
  decorators: InstalledPwaControlsRight.decorators,
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Search' }));
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole('dialog', { name: 'Search' });
    await waitFor(async () => {
      const bounds = dialog.getBoundingClientRect();
      await expect(bounds.top).toBeGreaterThanOrEqual(32);
      await expect(bounds.top).toBeLessThan(
        canvasElement.ownerDocument.defaultView!.innerHeight / 3
      );
    });
  },
};

export const InstalledPwaToolsDrawer: Story = {
  decorators: InstalledPwaControlsRight.decorators,
  render: () => (
    <>
      <WorkspaceHeaderFixture />
      <WorkspaceToolsDrawer open onOpenChange={() => undefined}>
        <div className="p-4">Workspace tools</div>
      </WorkspaceToolsDrawer>
    </>
  ),
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole('dialog', { name: 'Workspace tools' });
    await waitFor(async () => {
      const bounds = dialog.getBoundingClientRect();
      await expect(bounds.top).toBe(32);
      await expect(bounds.bottom).toBeLessThanOrEqual(
        canvasElement.ownerDocument.defaultView!.innerHeight
      );
    });
  },
};

import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { WorkspaceToolsDrawer } from '@/client/components/workspace-tools-drawer';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { WorkspaceHeaderFixture } from './workspace-header-fixture';
import { WorkspaceHeaderPwaPreview } from './workspace-header-pwa-preview';

const meta = {
  title: 'Navigation/AppHeader',
  component: WorkspaceHeaderFixture,
  parameters: {
    layout: 'fullscreen',
    docs: {
      // Native-geometry CSS and rem-based font previews need their own document
      // when the docs page shows several header stories at once.
      story: { inline: false, iframeHeight: 120 },
      description: {
        component:
          'The installed desktop PWA uses compact controls centered in the browser-reported title-bar area. A subtle theme-relative surface has tight S-curves on either side, leaving room for native controls. Larger fonts can grow the row without clipping. Empty space drags the window; interactive controls remain clickable. PWA stories simulate native geometry using the production CSS. Browser tabs and unsupported installations retain the standard header.',
      },
    },
  },
} satisfies Meta<typeof WorkspaceHeaderFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Workspace: Story = {};
export const WorkspaceFamily: Story = { args: { variant: 'family' } };
export const TabletWorkspace: Story = {
  globals: { viewport: { value: 'tablet', isRotated: false } },
};
export const PhoneWorkspace: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
export const Project: Story = { args: { variant: 'project' } };
export const Generic: Story = { args: { variant: 'generic' } };

export const InstalledPwaControlsLeft: Story = {
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
};
export const InstalledPwaLargeText: Story = {
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

export const ProjectListError: Story = {
  args: { projectsError: true },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

// Exercise the real header triggers, including the sideways sidebar tooltip.
export const InstalledPwaHeaderTooltips: Story = {
  decorators: InstalledPwaControlsRight.decorators,
  play: async ({ canvas, canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    for (const name of ['Toggle sidebar', 'Hide right panel']) {
      const trigger = canvas.getByRole('button', { name });
      await userEvent.hover(trigger);
      const tooltip = await body.findByRole('tooltip', { name });
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

export const PendingActions: Story = {
  args: { pendingActions: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('button', { name: 'Archiving workspace…' })
    ).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Opening in VS Code…' })).toBeDisabled();
    await userEvent.click(await canvas.findByRole('button', { name: /Stop dev server/ }));
    await expect(await canvas.findByRole('button', { name: 'Processing…' })).toBeDisabled();
  },
};
export const PendingActionsDark: Story = { ...PendingActions, globals: { theme: 'dark' } };

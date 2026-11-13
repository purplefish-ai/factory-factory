import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import type { WorkspaceHeaderFixture } from './workspace-header-fixture';
import { workspaceHeaderMeta } from './workspace-header-fixture.story-fixtures';

const meta = {
  ...workspaceHeaderMeta,
  title: 'Navigation/AppHeader',
} satisfies Meta<typeof WorkspaceHeaderFixture>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Workspace: Story = {
  play: async ({ canvas }) => {
    const search = canvas.getByRole('button', { name: 'Search' });
    const toggle = canvas.getByRole('button', { name: 'Hide right panel' });
    await expect(toggle.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      search.getBoundingClientRect().right
    );
    await userEvent.click(toggle);
    await expect(canvas.getByRole('button', { name: 'Show right panel' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Show right panel' }));
    await expect(canvas.getByRole('button', { name: 'Hide right panel' })).toBeVisible();
  },
};
/** The menu reads the parent through the workspace cache, as the app does. */
export const WorkspaceFamily: Story = {
  args: { variant: 'family' },
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Navigate workspace family' }));
    const menu = await within(canvasElement.ownerDocument.body).findByRole('menu');
    await within(menu).findByText('Waiting');
    await expect(menu).toHaveTextContent('Working');
  },
};
export const TabletWorkspace: Story = {
  globals: { viewport: { value: 'tablet', isRotated: false } },
};
export const PhoneWorkspace: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvas }) => {
    const toggle = canvas.getByRole('button', { name: 'Toggle sidebar' }).getBoundingClientRect();
    const context = canvas
      .getByRole('combobox', { name: /Open workspace menu/ })
      .getBoundingClientRect();
    const search = canvas.getByRole('button', { name: /^Search$/ }).getBoundingClientRect();
    await expect(context.left).toBeGreaterThanOrEqual(toggle.right);
    await expect(context.right).toBeLessThanOrEqual(search.left);
    await expect(
      Math.abs(context.top + context.height / 2 - search.top - search.height / 2)
    ).toBeLessThanOrEqual(1);
  },
};
export const PhoneFamily: Story = {
  args: { variant: 'family' },
  globals: { viewport: { value: 'phone', isRotated: false } },
};
export const WorkspaceDark: Story = { globals: { theme: 'dark' } };
export const PhoneWorkspaceDark: Story = {
  globals: { theme: 'dark', viewport: { value: 'phone', isRotated: false } },
};

export const Project: Story = { args: { variant: 'project' } };
export const Generic: Story = { args: { variant: 'generic' } };

export const ProjectListError: Story = {
  args: { projectsError: true },
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const NarrowPhoneFamily: Story = {
  args: { variant: 'family' },
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    viewport: {
      options: {
        phone: { name: 'Narrow phone', styles: { width: '320px', height: '640px' } },
      },
    },
  },
};

export const PhoneProject: Story = {
  args: { variant: 'project' },
  globals: { viewport: { value: 'phone', isRotated: false } },
};
export const PhoneGeneric: Story = {
  args: { variant: 'generic' },
  globals: { viewport: { value: 'phone', isRotated: false } },
};

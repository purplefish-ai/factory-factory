import type { Meta, StoryObj } from '@storybook/react';
import { Navigate, Route, Routes } from 'react-router';
import { expect, userEvent, within } from 'storybook/test';
import AdminDashboardPage from '@/client/routes/admin-page';
import { SettingsStoryLayout } from '@/client/routes/admin/settings-page-layout.story-fixtures';
import ProjectSettingsRedirect from './settings';

const project = {
  id: 'project-beta',
  slug: 'beta',
  name: 'Beta',
  issueProvider: 'GITHUB',
  issueTrackerConfig: null,
};
const meta = {
  title: 'Settings/InlineProjectSettings',
  component: AdminDashboardPage,
  parameters: {
    layout: 'fullscreen',
    trpc: {
      handlers: {
        'project.list': () => [project],
        'workspace.getFactoryConfig': () => ({
          scripts: { setup: 'pnpm install', run: 'pnpm dev --port {port}' },
        }),
      },
    },
  },
  render: () => (
    <SettingsStoryLayout>
      <div className="h-screen">
        <Routes>
          <Route path="/" element={<Navigate to="/projects/beta/settings" replace />} />
          <Route path="/projects/:slug/settings" element={<ProjectSettingsRedirect />} />
          <Route path="/admin/:section?" element={<AdminDashboardPage />} />
        </Routes>
      </div>
    </SettingsStoryLayout>
  ),
} satisfies Meta<typeof AdminDashboardPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ScopedProject: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const navigation = await canvas.findByRole('navigation', { name: 'Settings sections' });
    await expect(
      within(navigation).getByRole('link', { name: 'Project settings' })
    ).toHaveAttribute('aria-current', 'page');
    await expect(await canvas.findByRole('button', { name: 'Beta' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    await expect(canvas.getByText('Factory configuration')).toBeVisible();
  },
};
export const Phone: Story = {
  ...ScopedProject,
  globals: { viewport: { value: 'phone', isRotated: false } },
};
export const NotFound: Story = {
  parameters: { trpc: { handlers: { 'project.list': () => [] } } },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText(/No projects yet/)).toBeVisible();
  },
};
export const LoadError: Story = {
  parameters: {
    trpc: {
      handlers: {
        'project.list': () => {
          throw new Error('Service unavailable');
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText("Couldn't load projects")).toBeVisible();
  },
};
/** The project settings section shows the settings skeleton until the list loads. */
export const Loading: Story = {
  parameters: { trpc: { handlers: { 'project.list': () => new Promise(() => undefined) } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/Expand a project to configure/)).toBeVisible();
    await expect(canvasElement.querySelector('[data-slot="skeleton"]')).toBeVisible();
    await expect(canvas.queryByText(/No projects yet/)).toBeNull();
  },
};

export const LongProjectName: Story = {
  parameters: {
    trpc: {
      handlers: {
        'project.list': () => [
          { ...project, name: 'Factory Factory workspace management and developer tooling' },
        ],
      },
    },
  },
};
export const LinearOnPhone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    trpc: { handlers: { 'project.list': () => [{ ...project, issueProvider: 'LINEAR' }] } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByLabelText('API key')).toBeVisible();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
export const Unconfigured: Story = {
  parameters: { trpc: { handlers: { 'workspace.getFactoryConfig': () => null } } },
};

export const UnbrokenNamesOnPhone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    trpc: {
      handlers: {
        'project.list': () => [{ ...project, name: 'factory'.repeat(20) }],
        'workspace.getFactoryConfig': () => ({
          scripts: { run: `scripts/${'development/'.repeat(20)}start.sh` },
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: 'factory'.repeat(20) });
    await canvas.findByText(`scripts/${'development/'.repeat(20)}start.sh`);
    const script = canvas.getByRole('region', { name: 'Run script command' });
    await expect(script.scrollWidth).toBeGreaterThan(script.clientWidth);
    await expect(getComputedStyle(script).overflowX).toMatch(/^(auto|scroll)$/);
    const page = canvasElement.querySelector('.overflow-y-auto');
    if (!page) {
      throw new Error('Settings page is missing');
    }
    await expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth);
  },
};

const longCommand = `pnpm exec build ${'--filter workspace-package '.repeat(20)}`;
export const LongCommandsOnPhone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    trpc: {
      handlers: {
        'workspace.getFactoryConfig': () => ({
          scripts: {
            setup: longCommand,
            run: longCommand,
            postRun: longCommand,
            cleanup: longCommand,
          },
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('region', { name: 'Setup script command' });
    canvas.getByRole('button', { name: 'Refresh Workspaces' }).focus();
    for (const label of [
      'Setup script command',
      'Run script command',
      'Post-run script command',
      'Cleanup script command',
    ]) {
      const command = await canvas.findByRole('region', { name: label });
      await expect(command.scrollWidth).toBeGreaterThan(command.clientWidth);
      await expect(getComputedStyle(command).overflowX).toMatch(/^(auto|scroll)$/);
      await expect(getComputedStyle(command).whiteSpace).toBe('nowrap');
      await userEvent.tab();
      await expect(command).toHaveFocus();
      command.scrollLeft = command.scrollWidth;
      await expect(command.scrollLeft).toBeGreaterThan(0);
    }
    const page = canvasElement.querySelector('.overflow-y-auto');
    if (!page) {
      throw new Error('Settings page is missing');
    }
    await expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth);
  },
};

export const LinearDraftSurvivesCollapse: Story = {
  parameters: {
    trpc: { handlers: { 'project.list': () => [{ ...project, issueProvider: 'LINEAR' }] } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const apiKey = await canvas.findByLabelText('API key');
    await userEvent.type(apiKey, 'unsaved-linear-key');
    const trigger = canvas.getByRole('button', { name: 'Beta' });
    await userEvent.click(trigger);
    await expect(apiKey).not.toBeVisible();
    await userEvent.click(trigger);
    await expect(await canvas.findByLabelText('API key')).toHaveValue('unsaved-linear-key');
  },
};

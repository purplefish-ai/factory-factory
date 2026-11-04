import type { Meta, StoryObj } from '@storybook/react';
import { Navigate, Route, Routes } from 'react-router';
import { expect, userEvent, within } from 'storybook/test';
import { AppHeaderProvider } from '@/client/components/app-header-context';
import ProjectSettingsPage from './settings';

const project = {
  id: 'project-beta',
  slug: 'beta',
  name: 'Beta',
  issueProvider: 'GITHUB',
  issueTrackerConfig: null,
};
const meta = {
  title: 'Projects/ProjectSettingsPage',
  component: ProjectSettingsPage,
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
    <AppHeaderProvider>
      <div className="h-screen">
        <Routes>
          <Route path="/" element={<Navigate to="/projects/beta/settings" replace />} />
          <Route path="/projects/:slug/settings" element={<ProjectSettingsPage />} />
        </Routes>
      </div>
    </AppHeaderProvider>
  ),
} satisfies Meta<typeof ProjectSettingsPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ScopedProject: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const navigation = await canvas.findByRole('navigation', { name: 'Settings sections' });
    await expect(
      within(navigation).getByRole('link', { name: 'Project settings' })
    ).toHaveAttribute('aria-current', 'page');
    await expect(await canvas.findByRole('heading', { name: 'Beta settings' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Back to Board' })).toHaveAttribute(
      'href',
      '/projects/beta/workspaces'
    );
  },
};
export const Phone: Story = {
  ...ScopedProject,
  globals: { viewport: { value: 'phone', isRotated: false } },
};
export const NotFound: Story = {
  parameters: { trpc: { handlers: { 'project.list': () => [] } } },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('alert')).toHaveTextContent(
      'Project not found'
    );
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
    await expect(
      await within(canvasElement).findByText("Couldn't load project settings")
    ).toBeVisible();
  },
};
export const Loading: Story = {
  parameters: { trpc: { handlers: { 'project.list': () => new Promise(() => undefined) } } },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('Loading project settings…')).toBeVisible();
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
    await canvas.findByRole('heading', { name: `${'factory'.repeat(20)} settings` });
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

import type { Meta, StoryObj } from '@storybook/react';
import { Navigate, Route, Routes } from 'react-router';
import { expect, userEvent, within } from 'storybook/test';
import { DataImportResultsProvider } from '@/client/features/data-import';
import { STORY_TRPC_PENDING } from '@/client/lib/storybook-trpc';
import AdminDashboardPage from './admin-page';
import { SettingsStoryLayout } from './admin/settings-page-layout.story-fixtures';

const meta = {
  title: 'Settings/SettingsPage',
  component: AdminDashboardPage,
  parameters: { layout: 'fullscreen' },
  render: () => (
    <SettingsStoryLayout>
      <DataImportResultsProvider>
        <div className="flex h-screen flex-col">
          <Routes>
            <Route path="/" element={<Navigate to="/admin" replace />} />
            <Route path="/admin/:section?" element={<AdminDashboardPage />} />
          </Routes>
        </div>
      </DataImportResultsProvider>
    </SettingsStoryLayout>
  ),
} satisfies Meta<typeof AdminDashboardPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const GeneralWhileDiagnosticsPending: Story = {
  parameters: {
    trpc: {
      handlers: {
        'userSettings.get': () => ({ preferredIde: 'cursor' }),
        'admin.getSystemStats': () => STORY_TRPC_PENDING,
        'admin.getActiveProcesses': () => STORY_TRPC_PENDING,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('navigation', { name: 'Settings sections' })
    ).toBeVisible();
    await expect(await canvas.findByText('Preferred IDE')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'System' })).toHaveAttribute(
      'href',
      '/admin/system'
    );
  },
};

export const Phone: Story = {
  ...GeneralWhileDiagnosticsPending,
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const SystemBackendUnavailable: Story = {
  parameters: {
    trpc: {
      handlers: {
        'admin.getSystemStats': () => {
          throw new Error('Service unavailable');
        },
        'admin.getActiveProcesses': () => {
          throw new Error('Service unavailable');
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('link', { name: 'System' }));
    await expect(await canvas.findByText("Couldn't load API usage")).toBeVisible();
    await expect(await canvas.findByText("Couldn't load active processes")).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'General' })).toBeVisible();
  },
};
export const SystemPending: Story = {
  parameters: GeneralWhileDiagnosticsPending.parameters,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('link', { name: 'System' }));
    await expect(await canvas.findByText('Loading API usage…')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'General' })).toBeVisible();
  },
};

export const ProjectMenu: Story = {
  parameters: GeneralWhileDiagnosticsPending.parameters,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const header = within(canvas.getByRole('banner'));
    await expect(await header.findByRole('navigation', { name: 'Breadcrumb' })).toBeVisible();
    await expect(
      header.getByRole('button', { name: 'Open Factory Factory workspaces' })
    ).toBeVisible();
    await userEvent.click(header.getByRole('button', { name: 'Open project menu' }));
    const body = within(canvasElement.ownerDocument.body);
    await expect(await body.findByRole('menuitem', { name: '+ Create project' })).toHaveAttribute(
      'href',
      '/projects/new'
    );
    await expect(body.getByRole('menuitem', { name: 'Other project' })).toHaveAttribute(
      'href',
      '/projects/other/workspaces'
    );
    await userEvent.keyboard('{Escape}');
  },
};

export const PhoneProjectMenu: Story = {
  ...ProjectMenu,
  globals: { viewport: { value: 'phone', isRotated: false } },
};
export const Projects: Story = {
  parameters: {
    trpc: {
      handlers: {
        'workspace.getFactoryConfig': () => null,
        'project.list': () => [
          {
            id: 'alpha',
            slug: 'alpha',
            name: 'Alpha',
            issueProvider: 'GITHUB',
            issueTrackerConfig: null,
          },
          {
            id: 'beta',
            slug: 'beta',
            name: 'Factory Factory workspace management and developer tooling',
            issueProvider: 'GITHUB',
            issueTrackerConfig: null,
          },
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('link', { name: 'Project settings' }));
    const alpha = await canvas.findByRole('button', { name: 'Alpha' });
    await expect(alpha).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(alpha);
    await expect(alpha).toHaveAttribute('aria-expanded', 'true');
    await expect(await canvas.findByText('Factory configuration')).toBeVisible();
    await expect(canvas.getByText('Issue tracking')).toBeVisible();
    await userEvent.click(alpha);
    await expect(canvas.getByText('Factory configuration')).not.toBeVisible();
  },
};
export const ProjectsOnPhone: Story = {
  ...Projects,
  globals: { viewport: { value: 'phone', isRotated: false } },
};
export const NoProjects: Story = {
  parameters: { trpc: { handlers: { 'project.list': () => [] } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('link', { name: 'Project settings' }));
    await expect(await canvas.findByRole('link', { name: 'Add a project' })).toHaveAttribute(
      'href',
      '/projects/new'
    );
  },
};

export const NoSelectedProject: Story = {
  parameters: GeneralWhileDiagnosticsPending.parameters,
  render: () => (
    <SettingsStoryLayout selectedProjectSlug="">
      <AdminDashboardPage />
    </SettingsStoryLayout>
  ),
  play: async ({ canvasElement }) => {
    const header = within(within(canvasElement).getByRole('banner'));
    await expect(
      await header.findByRole('button', { name: 'Open Select a project workspaces' })
    ).toBeDisabled();
    await expect(header.getByRole('button', { name: 'Open project menu' })).toBeEnabled();
  },
};

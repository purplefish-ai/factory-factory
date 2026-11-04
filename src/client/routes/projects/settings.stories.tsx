import type { Meta, StoryObj } from '@storybook/react';
import { Navigate, Route, Routes } from 'react-router';
import { expect, within } from 'storybook/test';
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
  parameters: { layout: 'fullscreen', trpc: { handlers: { 'project.list': () => [project] } } },
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

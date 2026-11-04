import type { Meta, StoryObj } from '@storybook/react';
import { Navigate, Route, Routes } from 'react-router';
import { expect, userEvent, within } from 'storybook/test';
import { AppHeaderProvider } from '@/client/components/app-header-context';
import { DataImportResultsProvider } from '@/client/features/data-import';
import { STORY_TRPC_PENDING } from '@/client/lib/storybook-trpc';
import AdminDashboardPage from './admin-page';

const meta = {
  title: 'Settings/SettingsPage',
  component: AdminDashboardPage,
  parameters: { layout: 'fullscreen' },
  render: () => (
    <AppHeaderProvider>
      <DataImportResultsProvider>
        <div className="h-screen">
          <Routes>
            <Route path="/" element={<Navigate to="/admin" replace />} />
            <Route path="/admin/:section?" element={<AdminDashboardPage />} />
          </Routes>
        </div>
      </DataImportResultsProvider>
    </AppHeaderProvider>
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

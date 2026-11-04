import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { DataImportResultsProvider } from '@/client/features/data-import/data-import-results';
import NewProjectPage from '@/client/routes/projects/new';
import { AppLayout } from './resizable-layout';

const meta = {
  title: 'Navigation/FirstRun',
  component: AppLayout,
  parameters: {
    layout: 'fullscreen',
    trpc: {
      handlers: {
        'project.list': () => [],
        'project.checkGithubAuth': () => ({ isAuthenticated: true, username: 'developer' }),
        'admin.checkCLIHealth': () => null,
      },
    },
  },
  decorators: [
    (Story) => (
      <DataImportResultsProvider>
        <Story />
      </DataImportResultsProvider>
    ),
  ],
  args: { children: <NewProjectPage />, className: 'h-dvh' },
} satisfies Meta<typeof AppLayout>;
export default meta;
type Story = StoryObj<typeof meta>;
export const BrowserOnboarding: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Get started')).toBeVisible();
    await expect(canvas.getByRole('tab', { name: 'GitHub URL' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(canvas.queryByRole('button', { name: 'Toggle sidebar' })).not.toBeInTheDocument();
    await expect(canvasElement.querySelector('[data-slot="sidebar"]')).toBeNull();
  },
};
export const DesktopOnboarding: Story = {
  beforeEach: () => {
    const original = Object.getOwnPropertyDescriptor(window, 'electronAPI');
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { isElectron: true },
    });
    return () => {
      if (original) {
        Object.defineProperty(window, 'electronAPI', original);
      } else {
        Reflect.deleteProperty(window, 'electronAPI');
      }
    };
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('tab', { name: 'Local Path' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(canvas.getByLabelText('Repository Path')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Toggle sidebar' })).not.toBeInTheDocument();
  },
};
export const PhoneOnboarding: Story = {
  ...BrowserOnboarding,
  globals: { viewport: { value: 'phone', isRotated: false } },
};

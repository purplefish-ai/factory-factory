import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, within } from 'storybook/test';
import { DataImportResultsProvider } from '@/client/features/data-import/data-import-results';
import NewProjectPage from '@/client/routes/projects/new';
import { AppLayout, HeaderBoundary } from './resizable-layout';

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

const reportHeaderError = fn();

function CrashingHeader(): never {
  throw new TypeError("Cannot read properties of undefined (reading 'title')");
}

/** A header render error leaves a compact fallback in the header's place; the page keeps working. */
export const HeaderRenderError: Story = {
  render: () => (
    <div className="flex h-dvh flex-col bg-background">
      <HeaderBoundary>
        <CrashingHeader />
      </HeaderBoundary>
      <main className="flex-1 p-4 text-sm">Page content</main>
    </div>
  ),
  beforeEach: () => {
    // The boundary reports caught errors through `reportError`, which the test
    // runner would treat as an uncaught page error.
    const original = globalThis.reportError;
    globalThis.reportError = reportHeaderError;
    reportHeaderError.mockReset();
    return () => {
      globalThis.reportError = original;
    };
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent("Couldn't show the header");
    await expect(canvas.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(canvas.getByText('Page content')).toBeVisible();
    await expect(reportHeaderError).toHaveBeenCalled();
  },
};
export const HeaderRenderErrorDark: Story = {
  ...HeaderRenderError,
  globals: { theme: 'dark' },
};

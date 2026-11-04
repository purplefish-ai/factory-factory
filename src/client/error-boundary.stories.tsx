import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ErrorBoundary, ErrorFallback } from './error-boundary';

const onReload = fn();
const onReset = fn();
const reportError = fn();

function sampleError() {
  const error = new TypeError("Cannot read properties of undefined (reading 'sessions')");
  error.stack = `TypeError: Cannot read properties of undefined (reading 'sessions')
    at WorkspaceDetail (workspace-detail-view.tsx:187:21)
    at renderWithHooks (react-dom.development.js:15486:18)`;
  return error;
}

const COMPONENT_STACK = `
    at WorkspaceDetail
    at Suspense
    at ErrorBoundary
    at AppLayout`;

const meta = {
  title: 'Shared/ErrorBoundary',
  component: ErrorFallback,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  args: {
    error: sampleError(),
    componentStack: COMPONENT_STACK,
    onReload,
  },
  decorators: [
    (Story) => (
      <div className="h-[480px] w-full bg-background">
        <Story />
      </div>
    ),
  ],
  beforeEach: () => {
    onReload.mockReset();
    onReset.mockReset();
  },
} satisfies Meta<typeof ErrorFallback>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The app root and routed page area: Reload is primary, details can be copied. */
export const Page: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent("Couldn't show this page");
    await expect(canvas.getByRole('button', { name: 'Copy details' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Try again' })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Reload' }));
    await expect(onReload).toHaveBeenCalledOnce();
  },
};

export const PageDark: Story = {
  globals: { theme: 'dark' },
};

/** The routed page boundary also offers Try again; it resets on navigation too. */
export const PageWithRetry: Story = {
  args: { onReset },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Try again' }));
    await expect(onReset).toHaveBeenCalledOnce();
  },
};

export const PagePhone: Story = {
  args: { onReset },
  globals: { viewport: { value: 'phone', isRotated: false } },
};

/** Panel-level boundaries, such as the file viewer, fit inside the panel. */
export const Compact: Story = {
  args: { variant: 'compact', title: "Couldn't load the viewer" },
  decorators: [
    (Story) => (
      <div className="m-4 h-[260px] w-[320px] rounded-md border">
        <Story />
      </div>
    ),
  ],
};

export const CompactDark: Story = {
  ...Compact,
  globals: { theme: 'dark' },
};

export const LongMessage: Story = {
  args: {
    error: new Error(
      'ENOENT: no such file or directory, open /Users/example/factory-factory/worktrees/workspace-cmw1atjf7007ok5y4amnioxq6/.factory-factory/screenshots/a-very-long-file-name-that-wraps.png'
    ),
  },
};

const crashControl = { shouldCrash: true };

function CrashingPanel() {
  if (crashControl.shouldCrash) {
    throw new Error('Panel failed to render');
  }
  return <p className="p-4 text-sm">Panel recovered</p>;
}

/** A real boundary catches a render error; Try again re-renders once the cause is gone. */
export const CaughtByBoundary: Story = {
  render: () => (
    <div className="m-4 h-[260px] w-[320px] rounded-md border">
      <ErrorBoundary variant="compact" title="Couldn't show this panel" showRetry>
        <CrashingPanel />
      </ErrorBoundary>
    </div>
  ),
  beforeEach: () => {
    crashControl.shouldCrash = true;
    // The boundary reports caught errors through `reportError`, which the test
    // runner would treat as an uncaught page error. Capture it for this story.
    const original = globalThis.reportError;
    globalThis.reportError = reportError;
    reportError.mockReset();
    return () => {
      globalThis.reportError = original;
    };
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Panel failed to render');
    await expect(reportError).toHaveBeenCalled();
    crashControl.shouldCrash = false;
    await userEvent.click(canvas.getByRole('button', { name: 'Try again' }));
    await expect(await canvas.findByText('Panel recovered')).toBeVisible();
  },
};

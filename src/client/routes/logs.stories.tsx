import type { Meta, StoryObj } from '@storybook/react';
import { Navigate, Route, Routes } from 'react-router';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import {
  STORY_TRPC_PENDING,
  StoryTrpcProvider,
  storyTrpcHandlersFrom,
} from '@/client/lib/storybook-trpc';
import { SettingsStoryLayout } from './admin/settings-page-layout.story-fixtures';
import LogsPage from './logs';

const onRequest = fn();
const logs = {
  entries: [
    {
      timestamp: '2026-11-04T10:23:45.678Z',
      level: 'info',
      component: 'server',
      message: 'Story log entry',
      context: {},
    },
    {
      timestamp: '2026-11-04T10:23:44.678Z',
      level: 'warn',
      component: 'workspace',
      message: 'Workspace setup is taking longer than expected',
      context: { workspaceId: 'workspace-123' },
    },
    {
      timestamp: '2026-11-04T10:23:43.678Z',
      level: 'error',
      component: 'github',
      message: 'Unable to fetch pull request status',
      context: { status: 503 },
    },
    {
      timestamp: '2026-11-04T10:23:42.678Z',
      level: 'debug',
      component: 'session',
      message: 'Session heartbeat received',
      context: {},
    },
  ],
  total: 4,
  totalIsExact: true,
  hasMore: false,
  filePath: '/Users/developer/factory-factory/logs/server.log',
};
const meta = {
  title: 'Settings/LogsPage',
  component: LogsPage,
  parameters: { layout: 'fullscreen', trpc: { handlers: { 'admin.getLogs': () => logs } } },
  render: (_, { parameters }) => (
    <StoryTrpcProvider handlers={storyTrpcHandlersFrom(parameters)} onRequest={onRequest}>
      <SettingsStoryLayout>
        <div className="h-screen">
          <Routes>
            <Route path="/" element={<Navigate to="/admin/logs" replace />} />
            <Route path="/admin/logs" element={<LogsPage />} />
          </Routes>
        </div>
      </SettingsStoryLayout>
    </StoryTrpcProvider>
  ),
  beforeEach: () => {
    onRequest.mockClear();
  },
} satisfies Meta<typeof LogsPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Story log entry')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Server logs' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  },
};
export const RelativeRange: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Story log entry');
    const time = canvasElement.querySelector('time');
    await expect(time).toHaveAttribute('datetime', '2026-11-04T10:23:45.678Z');
    await expect(time).toHaveAttribute('title', '2026-11-04T10:23:45.678Z');
    await expect(time).toHaveTextContent(':45');
    const timeRange = canvas.getByRole('combobox', { name: 'Time range' });
    if (!timeRange) {
      throw new Error('Time range trigger is missing');
    }
    await userEvent.click(timeRange);
    await userEvent.click(
      await within(document.body).findByRole('option', { name: 'Last 5 minutes' })
    );
    await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.body).not.toHaveStyle({ pointerEvents: 'none' }));
    await userEvent.click(canvas.getByText('Story log entry'));
    await expect(await canvas.findByText('Raw JSON')).toBeVisible();
    await expect(onRequest).toHaveBeenCalledTimes(2);
  },
};

export const DatesDark: Story = { ...RelativeRange, globals: { theme: 'dark' } };

export const Loading: Story = {
  parameters: { trpc: { handlers: { 'admin.getLogs': () => STORY_TRPC_PENDING } } },
};
export const Empty: Story = {
  parameters: {
    trpc: { handlers: { 'admin.getLogs': () => ({ ...logs, entries: [], total: 0 }) } },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('No log entries found')).toBeVisible();
  },
};
export const LoadError: Story = {
  parameters: {
    trpc: {
      handlers: {
        'admin.getLogs': () => {
          throw new Error('Log file is unavailable');
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent("Couldn't load logs");
    await expect(canvas.getByRole('button', { name: 'Retry' })).toBeVisible();
  },
};
export const CustomRange: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Story log entry');
    await userEvent.click(canvas.getByRole('combobox', { name: 'Time range' }));
    await userEvent.click(
      await within(document.body).findByRole('option', { name: 'Custom range' })
    );
    await expect(canvas.getByRole('button', { name: 'Start date' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'End date' })).toBeVisible();
  },
};
export const Phone: Story = {
  ...Default,
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async (context) => {
    await Default.play?.(context);
    const root = context.canvasElement;
    await expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
  },
};

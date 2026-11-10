import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { Card, CardContent } from '@/components/ui/card';
import { QueryErrorState, QueryRefreshError } from './query-error-state';

const meta = {
  title: 'Shared/QueryErrorState',
  component: QueryErrorState,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  args: {
    className: 'rounded-lg border bg-card',
    title: "Couldn't load projects",
    error: { message: 'Failed to fetch' },
    onRetry: fn(),
    isRetrying: false,
  },
  decorators: [
    (Story) => (
      <div className="w-[480px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof QueryErrorState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent("Couldn't load projects");
    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }));
    await expect(args.onRetry).toHaveBeenCalledOnce();
  },
};

export const Retrying: Story = {
  args: { isRetrying: true },
};

export const WithoutDetail: Story = {
  args: { error: null },
};

export const LongServerMessage: Story = {
  args: {
    title: "Couldn't load screenshots",
    error: {
      message:
        'ENOENT: no such file or directory, scandir /Users/example/factory-factory/worktrees/workspace-cmw1atjf7007ok5y4amnioxq6/.factory-factory/screenshots',
    },
  },
};

/** The Settings page wraps the state in a card in place of the failed section. */
export const InSettingsCard: Story = {
  args: {
    className: undefined,
    title: "Couldn't load API usage",
    error: { message: 'Service unavailable' },
  },
  decorators: [
    (Story) => (
      <Card>
        <CardContent className="p-0">
          <Story />
        </CardContent>
      </Card>
    ),
  ],
};

/** Cached data stays on screen; the notice above it offers Retry. */
export const RefreshNotice: Story = {
  render: (args) => (
    <div className="flex h-40 flex-col rounded-lg border bg-card">
      <QueryRefreshError
        title="Couldn't refresh workspaces"
        error={{ message: 'Failed to fetch' }}
        onRetry={args.onRetry}
        isRetrying={args.isRetrying}
      />
      <p className="min-h-0 flex-1 p-3 text-sm">Previously loaded content</p>
    </div>
  ),
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent("Couldn't refresh workspaces.");
    await expect(canvas.getByText('Previously loaded content')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }));
    await expect(args.onRetry).toHaveBeenCalledOnce();
  },
};

export const RefreshNoticeRetrying: Story = {
  ...RefreshNotice,
  args: { isRetrying: true },
  play: undefined,
};

export const RefreshNoticeDark: Story = {
  ...RefreshNotice,
  globals: { theme: 'dark' },
  play: undefined,
};

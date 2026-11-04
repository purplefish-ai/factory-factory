import { CameraIcon } from '@phosphor-icons/react/dist/csr/Camera';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from './empty-state';
import { QueryState, type QueryStateQuery } from './query-state';

type Screenshots = { names: string[] };

const refetch = fn();

interface QueryStateStoryProps {
  data?: Screenshots;
  error?: string;
  isFetching?: boolean;
  skeleton?: boolean;
  size?: 'default' | 'compact';
}

/** Renders `QueryState` with a fixed query snapshot instead of a live query. */
function QueryStateStory({
  data,
  error,
  isFetching = false,
  skeleton,
  size,
}: QueryStateStoryProps) {
  const query: QueryStateQuery<Screenshots> = {
    data,
    error: error ? { message: error } : null,
    isFetching,
    refetch,
  };
  return (
    <div className="h-[320px] w-[420px] max-w-full rounded-md border bg-background">
      <QueryState
        query={query}
        errorTitle="Couldn't load screenshots"
        loadingMessage="Loading screenshots…"
        size={size}
        className="h-full"
        loading={
          skeleton ? (
            <div className="grid grid-cols-2 gap-2 p-2" aria-hidden="true">
              {['a', 'b', 'c', 'd'].map((key) => (
                <Skeleton key={key} className="aspect-video" />
              ))}
            </div>
          ) : undefined
        }
        isEmpty={(value) => value.names.length === 0}
        empty={
          <EmptyState
            icon={CameraIcon}
            title="No screenshots yet"
            description="Capture screenshots of the running dev app."
            className="h-full"
          />
        }
      >
        {(value) => (
          <ul className="divide-y text-sm">
            {value.names.map((name) => (
              <li key={name} className="px-3 py-2">
                {name}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </div>
  );
}

const meta = {
  title: 'Shared/QueryState',
  component: QueryStateStory,
  parameters: { layout: 'centered' },
  beforeEach: () => {
    refetch.mockReset();
  },
} satisfies Meta<typeof QueryStateStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  args: { isFetching: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent(
      'Loading screenshots…'
    );
  },
};

export const LoadingCompact: Story = {
  args: { isFetching: true, size: 'compact' },
};

/** A layout-known list loads as a skeleton instead of a spinner. */
export const LoadingSkeleton: Story = {
  args: { isFetching: true, skeleton: true },
};

/** An error without data shows Retry and never the empty state. */
export const LoadError: Story = {
  args: { error: 'Workspace worktree is missing; it may have been archived' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent("Couldn't load screenshots");
    await expect(canvas.queryByText('No screenshots yet')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }));
    await expect(refetch).toHaveBeenCalledOnce();
  },
};

export const LoadErrorDark: Story = {
  args: { error: 'Workspace worktree is missing; it may have been archived' },
  globals: { theme: 'dark' },
};

export const Retrying: Story = {
  args: { error: 'Failed to fetch', isFetching: true },
};

export const Empty: Story = {
  args: { data: { names: [] } },
};

export const EmptyDark: Story = {
  args: { data: { names: [] } },
  globals: { theme: 'dark' },
};

export const Content: Story = {
  args: { data: { names: ['home.png', 'settings.png', 'kanban.png'] } },
};

/** Cached data stays visible when only a background refetch fails. */
export const CachedDataWithRefetchError: Story = {
  args: { data: { names: ['home.png', 'settings.png'] }, error: 'Failed to fetch' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('home.png')).toBeVisible();
    await expect(canvas.queryByRole('alert')).toBeNull();
  },
};

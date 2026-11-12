import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import { z } from 'zod';
import { STORY_TRPC_PENDING } from '@/client/lib/storybook-trpc';
import { Button } from '@/components/ui/button';
import { eventRunFixture, eventRunPageFixture } from './event-history.story-fixtures';
import { EventRunHistory } from './event-run-history';

const cursorInput = z.object({ cursor: z.string().optional() });

function RunHistoryStory({ withActions = false }: { withActions?: boolean }) {
  return (
    <div className="max-w-2xl">
      <EventRunHistory
        projectId="owner"
        agentId="event-agent"
        projectSlug="demo"
        renderRunActions={
          withActions
            ? (run) =>
                run.launchPhase === 'NEEDS_ATTENTION' ? (
                  <Button variant="outline" size="sm">
                    Inspect
                  </Button>
                ) : null
            : undefined
        }
      />
    </div>
  );
}

const meta = {
  title: 'Automations/EventRunHistory',
  component: RunHistoryStory,
  parameters: {
    trpc: {
      handlers: {
        'automation.runs': () => ({ items: eventRunPageFixture(), nextCursor: null }),
      },
    },
  },
} satisfies Meta<typeof RunHistoryStory>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Queued, needs attention, PR created, cancelled for overflow, and failed with a deleted workspace. */
export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Needs attention')).toBeVisible();
    await expect(canvas.getByRole('link', { name: /PR #42/ })).toBeVisible();
    await expect(canvas.getByText('Workspace deleted')).toBeVisible();
  },
};

export const PopulatedDark: Story = { ...Populated, globals: { theme: 'dark' } };

export const PopulatedPhone: Story = {
  ...Populated,
  globals: { viewport: { value: 'phone', isRotated: false } },
};

/** Runs that finished while child workspaces were still working. */
export const ChildWork: Story = {
  parameters: {
    trpc: {
      handlers: {
        'automation.runs': () => ({
          items: [
            eventRunFixture({
              id: 'run-child-hold',
              status: 'COMPLETED',
              reasonCode: 'CHILD_HOLD_EXPIRED',
            }),
            eventRunFixture({
              id: 'run-child-abandoned',
              status: 'FAILED',
              reasonCode: 'ABANDONED_WITH_CHILD_WORK',
            }),
          ],
          nextCursor: null,
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/Child workspaces hadn't finished after 24 hours/)
    ).toBeVisible();
    await expect(
      canvas.getByText(/Abandoned by a person before its child workspaces had finished/)
    ).toBeVisible();
  },
};

/** The slot recovery controls fill; shown here with a placeholder button. */
export const WithRunActions: Story = {
  args: { withActions: true },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole('button', { name: 'Inspect' })
    ).toBeVisible();
  },
};

export const Loading: Story = {
  parameters: { trpc: { handlers: { 'automation.runs': () => STORY_TRPC_PENDING } } },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('Loading runs…')).toBeInTheDocument();
  },
};

export const Empty: Story = {
  parameters: {
    trpc: { handlers: { 'automation.runs': () => ({ items: [], nextCursor: null }) } },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('No runs yet')).toBeVisible();
  },
};

export const LoadError: Story = {
  parameters: {
    trpc: {
      handlers: {
        'automation.runs': () => {
          throw new Error('Database is locked');
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Couldn't load runs")).toBeVisible();
    await expect(canvas.queryByText('No runs yet')).not.toBeInTheDocument();
  },
};

/** Loading a later page; a failure keeps the loaded runs with a retry notice. */
export const LoadMoreError: Story = {
  parameters: {
    trpc: {
      handlers: {
        'automation.runs': (input: unknown) => {
          if (cursorInput.parse(input).cursor) {
            throw new Error('Database is locked');
          }
          return { items: eventRunPageFixture().slice(0, 2), nextCursor: 'runs-page-2' };
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Load more runs' }));
    await expect(await canvas.findByText(/Couldn't load more runs/)).toBeVisible();
    await expect(canvas.getByText('Needs attention')).toBeVisible();
  },
};

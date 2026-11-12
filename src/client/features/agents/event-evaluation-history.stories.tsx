import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { STORY_TRPC_PENDING } from '@/client/lib/storybook-trpc';
import { EventEvaluationHistory } from './event-evaluation-history';
import { eventEvaluationPageFixture } from './event-history.story-fixtures';

function EvaluationHistoryStory() {
  return (
    <div className="max-w-2xl">
      <EventEvaluationHistory
        projectId="owner"
        agentId="event-agent"
        triggerLabels={{ 'saved-event:github': 'Investigate labeled issues' }}
      />
    </div>
  );
}

const meta = {
  title: 'Automations/EventEvaluationHistory',
  component: EvaluationHistoryStory,
  parameters: {
    trpc: {
      handlers: {
        'automation.evaluations': () => ({
          items: eventEvaluationPageFixture(),
          nextCursor: 'events-page-2',
        }),
      },
    },
  },
} satisfies Meta<typeof EvaluationHistoryStory>;
export default meta;
type Story = StoryObj<typeof meta>;

/** An errored decision that will retry, a skipped event and a match that started a run. */
export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("The event's label doesn't match this trigger.")
    ).toBeVisible();
    await expect(canvas.getByText('Started a run')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Load more events' })).toBeVisible();
  },
};

export const PopulatedDark: Story = { ...Populated, globals: { theme: 'dark' } };

export const PopulatedPhone: Story = {
  ...Populated,
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const Loading: Story = {
  parameters: { trpc: { handlers: { 'automation.evaluations': () => STORY_TRPC_PENDING } } },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('Loading events…')).toBeInTheDocument();
  },
};

export const Empty: Story = {
  parameters: {
    trpc: { handlers: { 'automation.evaluations': () => ({ items: [], nextCursor: null }) } },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('No events yet')).toBeVisible();
  },
};

export const LoadError: Story = {
  parameters: {
    trpc: {
      handlers: {
        'automation.evaluations': () => {
          throw new Error('Database is locked');
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Couldn't load events")).toBeVisible();
    await expect(canvas.queryByText('No events yet')).not.toBeInTheDocument();
  },
};

import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { STORY_TRPC_PENDING } from '@/client/lib/storybook-trpc';
import { AutomationOriginPanel } from './automation-origin-panel';
import { automationOriginFixture } from './automation-origin-panel.story-fixtures';

const fixture = automationOriginFixture();
const handlers = {
  'automation.workspaceOrigin': () => fixture.origin,
  'automation.get': () => fixture.agent,
  'project.getById': () => fixture.project,
};

function OriginPanelStory() {
  return (
    <div className="h-[480px] w-[400px] border">
      <AutomationOriginPanel workspaceId="workspace-pr" projectId="owner" />
    </div>
  );
}

const meta = {
  title: 'Workspace/AutomationOriginPanel',
  component: OriginPanelStory,
  parameters: { trpc: { handlers } },
} satisfies Meta<typeof OriginPanelStory>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The Runs tab of an event-run workspace: its automation and the run that started it. */
export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Investigate labeled issues')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Manage automation' })).toHaveAttribute(
      'href',
      '/projects/demo/agents/event-agent?kind=event'
    );
  },
};

export const PopulatedDark: Story = { ...Populated, globals: { theme: 'dark' } };

/** A run held for a person after its first message may have been sent. */
export const NeedsAttention: Story = {
  parameters: {
    trpc: {
      handlers: {
        ...handlers,
        'automation.workspaceOrigin': () =>
          fixture.origin && {
            ...fixture.origin,
            run: fixture.origin.run && {
              ...fixture.origin.run,
              status: 'RUNNING',
              launchPhase: 'NEEDS_ATTENTION',
              reasonCode: 'DELIVERY_UNCERTAIN',
              completedAt: null,
              result: null,
              initialOutcome: null,
            },
          },
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('Needs attention')).toBeVisible();
  },
};

export const Loading: Story = {
  parameters: {
    trpc: { handlers: { ...handlers, 'automation.workspaceOrigin': () => STORY_TRPC_PENDING } },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('Loading automation…')).toBeVisible();
  },
};

export const LoadError: Story = {
  parameters: {
    trpc: {
      handlers: {
        ...handlers,
        'automation.workspaceOrigin': () => {
          throw new Error('Database is locked');
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText("Couldn't load automation")).toBeVisible();
  },
};

/** The run record is gone, for example after its automation was deleted. */
export const RunNotKept: Story = {
  parameters: {
    trpc: {
      handlers: {
        ...handlers,
        'automation.workspaceOrigin': () => fixture.origin && { ...fixture.origin, run: null },
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('No automation run linked')).toBeVisible();
  },
};

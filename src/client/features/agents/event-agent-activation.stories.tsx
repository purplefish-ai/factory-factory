import type { Meta, StoryObj } from '@storybook/react';
import { TRPCError } from '@trpc/server';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Loading } from '@/client/components/loading';
import { trpc } from '@/client/lib/trpc';
import { managedAgentSchema } from '@/shared/agent-management';
import { EventAgentDetail } from './event-agent-detail';
import {
  backendEnable,
  backendPause,
  backendResetSource,
  eventAgentFixture,
  triggerInBackendState,
} from './event-agent.test-support';
import type { EventAgent } from './types';

type Trigger = EventAgent['configuredTriggers'][number];
const updatedAt = '2026-11-12T09:00:00.000Z';
const base = eventAgentFixture();
const github = base.configuredTriggers[0]!;

function withTriggers(triggers: Trigger[], overrides: Partial<EventAgent> = {}): EventAgent {
  return managedAgentSchema.parse({ ...base, ...overrides, configuredTriggers: triggers });
}
function githubTrigger(overrides: Partial<Trigger>): Trigger {
  return { ...github, ...overrides };
}
// Each state uses the backend's exact fields: only ACTIVE has isEnabled: true.
const listening: Trigger = {
  ...triggerInBackendState(github, 'ACTIVE'),
  activationGeneration: 1,
  sourceHealth: { state: 'READY', reasonCode: null, updatedAt },
};
const starting: Trigger = {
  ...triggerInBackendState(github, 'STARTING'),
  activationGeneration: 1,
  sourceHealth: { state: 'ERROR', reasonCode: 'GITHUB_BASELINE_REQUIRED', updatedAt },
};
function pausedWith(pausedReasonCode: Trigger['pausedReasonCode']): Trigger {
  return { ...triggerInBackendState(github, 'PAUSED', pausedReasonCode), activationGeneration: 2 };
}
const slack: Trigger = {
  ...github,
  id: 'saved-event:slack',
  configuration: {
    type: 'SLACK_MESSAGE',
    connectionId: 'slack-connection',
    description: 'Feedback channel messages',
    filterInstructions: null,
    isEnabled: false,
    config: {
      version: 1,
      channelIds: ['C1'],
      context: { includeThread: true, nearbyMessageCount: 0 },
    },
  },
  capability: {
    status: 'UNAVAILABLE',
    reasonCode: 'SLACK_INTAKE_UNAVAILABLE',
    explanation: 'Slack event intake is not running in this app yet.',
  },
  sourceName: '#customer-feedback',
};
const opened: Trigger = {
  ...github,
  id: 'saved-event:opened',
  configuration: {
    type: 'GITHUB_ISSUE',
    connectionId: 'github-connection',
    description: 'Triage newly opened issues',
    filterInstructions: null,
    isEnabled: false,
    config: { version: 1, repositoryIds: ['repo-1'], actions: ['opened'] },
  },
  capability: {
    status: 'UNSUPPORTED',
    reasonCode: 'UNSUPPORTED_GITHUB_ACTION',
    explanation: 'Only labeled and reopened GitHub issue events can start runs.',
  },
};
const recovery: Trigger = {
  ...pausedWith('SOURCE_RECOVERY_REQUIRED'),
  sourceHealth: { state: 'RECOVERY_REQUIRED', reasonCode: 'GITHUB_CONTINUITY_LOST', updatedAt },
};

/**
 * The automation the story's `automation.get` answers with. Enable, Pause and
 * Reset change it exactly as the backend does (see the test-support helpers).
 */
let current: EventAgent = base;
const handlers = {
  'automation.get': () => current,
  'automation.enable': () => {
    current = backendEnable(current);
    return current;
  },
  'automation.pause': () => {
    current = backendPause(current);
    return current;
  },
  'automation.resetSource': () => {
    current = backendResetSource(current, 'github-connection', updatedAt);
    return { connectionId: 'github-connection', pausedTriggerCount: 3, cancelledRunCount: 1 };
  },
};

/** Reads the automation through tRPC, as the page does, so mutations update what is shown. */
function SavedEventDetail({ agent, archived = false }: { agent: EventAgent; archived?: boolean }) {
  const query = trpc.automation.get.useQuery({ projectId: agent.projectId, agentId: agent.id });
  if (query.error) {
    return <p role="alert">{query.error.message}</p>;
  }
  if (!query.data) {
    return <Loading size="compact" message="Loading automation…" />;
  }
  return (
    <main className="mx-auto min-w-0 max-w-3xl p-4">
      <EventAgentDetail agent={query.data} archived={archived} onEdit={() => undefined} />
    </main>
  );
}

const meta = {
  title: 'Automations/EventAutomationDetail',
  component: SavedEventDetail,
  parameters: { layout: 'fullscreen', trpc: { handlers } },
  args: { agent: base },
  beforeEach: ({ args }) => {
    current = args.agent;
  },
} satisfies Meta<typeof SavedEventDetail>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Paused: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Enable' })).toBeEnabled();
    await expect(canvas.getAllByText('Paused').length).toBeGreaterThan(0);
  },
};
export const Starting: Story = { args: { agent: withTriggers([starting], { isEnabled: true }) } };
export const Listening: Story = {
  args: { agent: withTriggers([listening], { isEnabled: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Pause' })).toBeEnabled();
    await expect(canvas.getByText('Listening')).toBeVisible();
    await expect(canvas.getByText(/Runs already started continue/)).toBeVisible();
  },
};
export const PausedAfterSourceError: Story = {
  args: { agent: withTriggers([pausedWith('SOURCE_ERROR')], { isEnabled: true }) },
};
export const PausedAfterStartTimedOut: Story = {
  args: { agent: withTriggers([pausedWith('ACTIVATION_EXPIRED')], { isEnabled: true }) },
};
export const CantRun: Story = {
  args: { agent: withTriggers([listening, opened, slack], { isEnabled: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findAllByText("Can't run")).toHaveLength(2);
    await expect(canvas.getByText(/Slack event intake is not running/)).toBeVisible();
  },
};
export const EnableStartsListening: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Enable' }));
    // The response stores the starting trigger with isEnabled: false, as the backend does.
    await expect(await canvas.findByRole('button', { name: 'Pause' })).toBeEnabled();
    await expect(canvas.getAllByText('Starting').length).toBeGreaterThan(0);
    await expect(canvas.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument();
  },
};
export const EnableRejected: Story = {
  args: { agent: withTriggers([slack]) },
  parameters: {
    trpc: {
      handlers: {
        ...handlers,
        'automation.enable': () => {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              'No trigger in this automation can start. Slack event intake is not running in this app yet.',
          });
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Enable' }));
    const alert = await canvas.findByRole('alert');
    await expect(alert).toHaveTextContent("Couldn't enable this automation.");
    await expect(alert).toHaveTextContent('No trigger in this automation can start.');
  },
};
export const EnableConflict: Story = {
  parameters: {
    trpc: {
      handlers: {
        ...handlers,
        'automation.enable': () => {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This automation changed. Reload it and try again.',
          });
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Enable' }));
    await expect(await canvas.findByRole('button', { name: 'Reload automation' })).toBeVisible();
    await expect(canvas.getByText('This automation changed since it was loaded.')).toBeVisible();
  },
};
export const NeedsSourceReset: Story = {
  args: { agent: withTriggers([recovery], { isEnabled: true }) },
};
export const ResetSourceDialog: Story = {
  args: { agent: withTriggers([recovery], { isEnabled: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Reset source' }));
    const dialog = within(canvasElement.ownerDocument.body).getByRole('alertdialog');
    await expect(dialog).toHaveTextContent('Events from the gap will not run.');
    await expect(dialog).toHaveTextContent('including automations in other projects');
  },
};
export const ResetSourceSucceeds: Story = {
  args: { agent: withTriggers([recovery], { isEnabled: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Reset source' }));
    const dialog = within(within(canvasElement.ownerDocument.body).getByRole('alertdialog'));
    await userEvent.click(dialog.getByRole('button', { name: 'Reset source' }));
    await expect(await canvas.findByRole('status')).toHaveTextContent('Source reset.');
    await waitFor(() =>
      expect(
        canvas.getByText(/Reset\. Enable the automation to listen from now on\./)
      ).toBeVisible()
    );
  },
};
export const ResetSourceRejected: Story = {
  args: { agent: withTriggers([recovery], { isEnabled: true }) },
  parameters: {
    trpc: {
      handlers: {
        ...handlers,
        'automation.resetSource': () => {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'The source no longer needs a reset.',
          });
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Reset source' }));
    const dialog = within(within(canvasElement.ownerDocument.body).getByRole('alertdialog'));
    await userEvent.click(dialog.getByRole('button', { name: 'Reset source' }));
    await expect(await dialog.findByRole('alert')).toHaveTextContent(
      'The source no longer needs a reset.'
    );
  },
};
export const AwaitingEnableAfterReset: Story = {
  args: {
    agent: withTriggers(
      [
        githubTrigger({
          sourceHealth: { state: 'DISCONNECTED', reasonCode: 'GITHUB_SOURCE_RESET', updatedAt },
        }),
      ],
      { isEnabled: true }
    ),
  },
};
export const Archived: Story = {
  args: { agent: withTriggers([listening, recovery], { isEnabled: true }), archived: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Pause' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Reset source' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Edit automation' })).toBeDisabled();
  },
};
export const ListeningDark: Story = { ...Listening, globals: { theme: 'dark' } };
export const PhoneCantRun: Story = {
  ...CantRun,
  globals: { viewport: { value: 'phone', isRotated: false } },
};

import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import { Loading } from '@/client/components/loading';
import { trpc } from '@/client/lib/trpc';
import { managedAgentSchema } from '@/shared/agent-management';
import { EventAgentDetail } from './event-agent-detail';
import {
  backendEnable,
  backendExpireActivation,
  backendVerifySlackChannel,
  eventAgentFixture,
  slackTriggerFixture,
} from './event-agent.test-support';
import type { EventAgent } from './types';

type Trigger = EventAgent['configuredTriggers'][number];
const updatedAt = '2026-11-12T09:00:05.000Z';
const ready = { state: 'READY' as const, reasonCode: null, updatedAt };

/** A saved Slack automation over two channels, read with intake on and the app token saved. */
function slackAgent(trigger: Trigger = slackTriggerFixture(['C1', 'C2'])): EventAgent {
  const base = eventAgentFixture();
  return managedAgentSchema.parse({
    ...base,
    name: 'Answer support questions',
    specification: base.specification && {
      ...base.specification,
      name: 'Answer support questions',
      triggers: trigger.configuration ? [{ ...trigger.configuration, id: trigger.id }] : [],
    },
    configuredTriggers: [trigger],
  });
}
/** The listener reports READY once its socket is open. */
function connected(agent: EventAgent): EventAgent {
  return {
    ...agent,
    configuredTriggers: agent.configuredTriggers.map((trigger) => ({
      ...trigger,
      sourceHealth: ready,
    })),
  };
}
const paused = slackAgent();
const connecting = backendEnable(paused);
const waiting = connected(connecting);
const oneReceived = backendVerifySlackChannel(waiting, 'C1');
const listening = backendVerifySlackChannel(oneReceived, 'C2');
const expired = backendExpireActivation(oneReceived);

/**
 * The automation the story's `automation.get` answers with; Enable changes it
 * exactly as the backend does (see the test-support helpers).
 */
let current: EventAgent = paused;
const handlers = {
  'automation.get': () => current,
  'automation.enable': () => {
    current = backendEnable(current);
    return current;
  },
};

function SavedEventDetail({ agent }: { agent: EventAgent }) {
  const query = trpc.automation.get.useQuery({ projectId: agent.projectId, agentId: agent.id });
  if (!query.data) {
    return <Loading size="compact" message="Loading automation…" />;
  }
  return (
    <main className="mx-auto min-w-0 max-w-3xl p-4">
      <EventAgentDetail agent={query.data} onEdit={() => undefined} />
    </main>
  );
}

const meta = {
  title: 'Automations/SlackVerification',
  component: SavedEventDetail,
  parameters: { layout: 'fullscreen', trpc: { handlers } },
  args: { agent: paused },
  beforeEach: ({ args }) => {
    current = args.agent;
  },
} satisfies Meta<typeof SavedEventDetail>;
export default meta;
type Story = StoryObj<typeof meta>;

export const EnableShowsTestMessage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Enable' }));
    await expect(await canvas.findByText('Connecting…')).toBeVisible();
    await expect(canvas.getByText('Factory Factory check 7kq2-m9xh-c4tr')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Copy message' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Pause' })).toBeEnabled();
  },
};
export const Connecting: Story = { args: { agent: connecting } };
export const WaitingForTestMessage: Story = {
  args: { agent: waiting },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Connected; waiting for test message')).toBeVisible();
    const channels = within(canvas.getByRole('list', { name: 'Channels' }));
    await expect(channels.getByText('#support')).toBeVisible();
    await expect(channels.getByText('#customer-feedback')).toBeVisible();
    await expect(channels.getAllByText('Waiting')).toHaveLength(2);
  },
};
export const OneChannelReceived: Story = {
  args: { agent: oneReceived },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Received')).toBeVisible();
    await expect(canvas.getByText(/1 of 2 received/)).toBeVisible();
  },
};
export const ListeningAfterEveryChannel: Story = {
  args: { agent: listening },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Listening')).toBeVisible();
    await expect(canvas.queryByText(/Factory Factory check/)).not.toBeInTheDocument();
  },
};
export const ExpiredBeforeEveryChannel: Story = {
  args: { agent: expired },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/didn't arrive in every channel/)).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Enable' })).toBeEnabled();
    await expect(canvas.queryByText(/Factory Factory check/)).not.toBeInTheDocument();
  },
};
export const WaitingDark: Story = { args: { agent: oneReceived }, globals: { theme: 'dark' } };
export const PhoneWaiting: Story = {
  args: { agent: oneReceived },
  globals: { viewport: { value: 'phone', isRotated: false } },
};

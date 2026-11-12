import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import { STORY_TRPC_PENDING, type StoryTrpcHandlers } from '@/client/lib/storybook-trpc';
import { EventAgentHistory } from './event-agent-history';
import { eventAgentFixture } from './event-agent.test-support';
import { eventRunFixture } from './event-history.story-fixtures';
import {
  type RecoveryFixture,
  recoveryInspectionFixture,
  recoveryResultFixture,
  recoveryRunFixture,
  recoveryTargetFixture,
  staleRecoveryContextError,
  unavailableTargetFixture,
  unprovenAbandonedRunFixture,
} from './event-run-recovery.story-fixtures';

/** The Runs view with one run in a recovery state above a finished run. */
function handlersFor(
  recovery: RecoveryFixture,
  overrides: StoryTrpcHandlers = {},
  options: { retryUnavailable?: boolean } = {}
): StoryTrpcHandlers {
  return {
    'automation.runs': () => ({
      items: [recoveryRunFixture(recovery), eventRunFixture()],
      nextCursor: null,
    }),
    'automation.recoveryTarget': () => recoveryTargetFixture(recovery),
    'automation.inspectRun': () => recoveryInspectionFixture(recovery, options),
    'automation.resolveAmbiguousRun': (input) => recoveryResultFixture(input),
    'automation.navigationSummary': () => ({ totalCount: 1, failedCount: 0 }),
    ...overrides,
  };
}

function RecoveryStory({ archived = false }: { archived?: boolean }) {
  return (
    <div className="max-w-2xl">
      <EventAgentHistory agent={eventAgentFixture()} projectSlug="demo" archived={archived} />
    </div>
  );
}

const meta = {
  title: 'Automations/EventRunRecovery',
  component: RecoveryStory,
  parameters: { trpc: { handlers: handlersFor('deliveryUncertain') } },
} satisfies Meta<typeof RecoveryStory>;
export default meta;
type Story = StoryObj<typeof meta>;
type PlayContext = Parameters<NonNullable<Story['play']>>[0];

const page = (canvasElement: HTMLElement) => within(canvasElement.ownerDocument.body);

async function inspect({ canvasElement }: PlayContext) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: 'Inspect' }));
  return within(await page(canvasElement).findByRole('dialog', { name: 'Recover run' }));
}

async function chooseAction(
  context: PlayContext,
  action: 'Resolve' | 'Abandon' | 'Retry' | 'Abandon anyway'
) {
  const dialog = await inspect(context);
  await userEvent.click(await dialog.findByRole('button', { name: action }));
  return within(await page(context.canvasElement).findByRole('alertdialog'));
}

/** A run whose first message may have reached the agent; Inspect is the way in. */
export const NeedsAttention: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Needs attention')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Inspect' })).toBeEnabled();
  },
};

export const NeedsAttentionPhone: Story = {
  ...NeedsAttention,
  globals: { viewport: { value: 'phone', isRotated: false } },
};

/** Resolve keeps the run open and holding its slot, so it still reads as needing attention. */
export const MarkedResolved: Story = {
  parameters: { trpc: { handlers: handlersFor('resolved') } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Needs attention')).toBeVisible();
    await expect(canvas.getByText(/keeps its run slot until someone retries/)).toBeVisible();
  },
};

export const InspectionLoading: Story = {
  parameters: {
    trpc: {
      handlers: handlersFor('deliveryUncertain', {
        'automation.recoveryTarget': () => STORY_TRPC_PENDING,
      }),
    },
  },
  play: async (context) => {
    const dialog = await inspect(context);
    await expect(await dialog.findByText('Checking this run…')).toBeInTheDocument();
  },
};

export const InspectionFailed: Story = {
  parameters: {
    trpc: {
      handlers: handlersFor('deliveryUncertain', {
        'automation.inspectRun': () => {
          throw new Error('Database is locked');
        },
      }),
    },
  },
  play: async (context) => {
    const dialog = await inspect(context);
    await expect(await dialog.findByText("Couldn't check this run")).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Retry' })).toBeVisible();
  },
};

/** The run changed between reading its target and inspecting it. */
export const InspectionConflict: Story = {
  parameters: {
    trpc: {
      handlers: handlersFor('deliveryUncertain', {
        'automation.inspectRun': () => {
          throw staleRecoveryContextError();
        },
      }),
    },
  },
  play: async (context) => {
    const dialog = await inspect(context);
    await expect(await dialog.findByText('This run changed')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Reload' })).toBeVisible();
  },
};

/** Lost delivery tracking: only Abandon anyway, which accepts that the stop is unproven. */
export const AbandonAnywayOffered: Story = {
  play: async (context) => {
    const dialog = await inspect(context);
    await expect(
      await dialog.findByText("Resolve, Retry and Abandon aren't available")
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Abandon anyway' })).toBeEnabled();
    await expect(dialog.queryByRole('button', { name: 'Abandon' })).not.toBeInTheDocument();
  },
};

/** Blocked with no unproven Abandon either (for example another owner holds the session). */
export const NothingAvailable: Story = {
  parameters: {
    trpc: {
      handlers: handlersFor('deliveryUncertain', {
        'automation.inspectRun': () => ({
          ...recoveryInspectionFixture('deliveryUncertain'),
          unprovenAbandonAvailable: false,
        }),
      }),
    },
  },
  play: async (context) => {
    const dialog = await inspect(context);
    await expect(await dialog.findByText('No recovery action is available')).toBeVisible();
    await expect(dialog.queryByRole('button', { name: /Abandon/ })).not.toBeInTheDocument();
  },
};

export const ConfirmAbandonAnyway: Story = {
  play: async (context) => {
    const confirm = await chooseAction(context, 'Abandon anyway');
    await expect(await confirm.findByText('Its agent may still be running')).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Abandon anyway' })).toBeEnabled();
  },
};

/** A completed first turn whose tracking was lost in a restart keeps its Completed result. */
export const ConfirmAbandonAnywayCompletedTurn: Story = {
  parameters: { trpc: { handlers: handlersFor('trackingLost') } },
  play: async (context) => {
    const confirm = await chooseAction(context, 'Abandon anyway');
    await expect(
      await confirm.findByText(/keep the result of its own first turn: it's recorded as Completed/)
    ).toBeVisible();
  },
};

export const ConfirmAbandonAnywayPhone: Story = {
  ...ConfirmAbandonAnyway,
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const AbandonedAnyway: Story = {
  play: async (context) => {
    const confirm = await chooseAction(context, 'Abandon anyway');
    await userEvent.click(confirm.getByRole('button', { name: 'Abandon anyway' }));
    await expect(
      await within(context.canvasElement).findByText(/couldn't confirm its agent stopped/)
    ).toBeVisible();
  },
};

/** The history row once a run was abandoned without a confirmed stop. */
export const AbandonedUnprovenInHistory: Story = {
  parameters: {
    trpc: {
      handlers: handlersFor('deliveryUncertain', {
        'automation.runs': () => ({ items: [unprovenAbandonedRunFixture()], nextCursor: null }),
      }),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/couldn't confirm its agent had stopped/)).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Inspect' })).not.toBeInTheDocument();
  },
};

export const SetupCleanupUncertain: Story = {
  parameters: { trpc: { handlers: handlersFor('setupUncertain') } },
  play: async (context) => {
    const dialog = await inspect(context);
    await expect(await dialog.findByText(/cleanup couldn't be confirmed/)).toBeVisible();
    await expect(dialog.getByText('Not sent.')).toBeVisible();
  },
};

/** The first turn ended; every action is available. */
export const AllActionsAvailable: Story = {
  parameters: { trpc: { handlers: handlersFor('heldAfterTurn') } },
  play: async (context) => {
    const dialog = await inspect(context);
    for (const action of ['Resolve', 'Retry', 'Abandon']) {
      await expect(await dialog.findByRole('button', { name: action })).toBeEnabled();
    }
  },
};

export const AllActionsAvailableDark: Story = {
  ...AllActionsAvailable,
  globals: { theme: 'dark' },
};

/** The reserved workspace is gone: Retry is blocked with its reason, the others remain. */
export const RetryUnavailable: Story = {
  parameters: { trpc: { handlers: handlersFor('heldAfterTurn', {}, { retryUnavailable: true }) } },
  play: async (context) => {
    const dialog = await inspect(context);
    await expect(await dialog.findByText(/Retry isn't available/)).toBeVisible();
    await expect(dialog.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    await expect(dialog.getByRole('button', { name: 'Abandon' })).toBeEnabled();
  },
};

/** Child workspaces still working: only Abandon, with the count and the deadline. */
export const ChildHold: Story = {
  parameters: { trpc: { handlers: handlersFor('childHeld') } },
  play: async (context) => {
    const dialog = await inspect(context);
    await expect(await dialog.findByText('Waiting on 2 child workspaces')).toBeVisible();
    await expect(dialog.getByText(/ends on its own/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Abandon' })).toBeEnabled();
    await expect(dialog.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
  },
};

export const ChildHoldPhone: Story = {
  ...ChildHold,
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const ConfirmAbandonChildHold: Story = {
  parameters: { trpc: { handlers: handlersFor('childHeld') } },
  play: async (context) => {
    const confirm = await chooseAction(context, 'Abandon');
    await expect(await confirm.findByText(/This run will keep its outcome/)).toBeVisible();
    await expect(confirm.getByText(/doesn't stop this run's child workspaces/)).toBeVisible();
  },
};

export const ConfirmRetry: Story = {
  parameters: { trpc: { handlers: handlersFor('heldAfterTurn') } },
  play: async (context) => {
    const confirm = await chooseAction(context, 'Retry');
    await expect(
      await confirm.findByText('Earlier effects may already have happened')
    ).toBeVisible();
  },
};

export const ConfirmResolve: Story = {
  parameters: { trpc: { handlers: handlersFor('heldAfterTurn') } },
  play: async (context) => {
    const confirm = await chooseAction(context, 'Resolve');
    await expect(await confirm.findByText(/keeps its run slot/)).toBeVisible();
  },
};

/** Another tab retried the run first: the dialog stays open and offers only Reload. */
export const StaleContext: Story = {
  parameters: {
    trpc: {
      handlers: handlersFor('heldAfterTurn', {
        'automation.resolveAmbiguousRun': () => {
          throw staleRecoveryContextError();
        },
      }),
    },
  },
  play: async (context) => {
    const confirm = await chooseAction(context, 'Abandon');
    await userEvent.click(confirm.getByRole('button', { name: 'Abandon run' }));
    await expect(await confirm.findByText('This run changed')).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Reload' })).toBeVisible();
    await expect(confirm.queryByRole('button', { name: 'Abandon run' })).not.toBeInTheDocument();
  },
};

/** A child appeared after inspection: the server blocks the action and nothing changes. */
export const ActionBlocked: Story = {
  parameters: {
    trpc: {
      handlers: handlersFor('childHeld', {
        'automation.resolveAmbiguousRun': (input) =>
          recoveryResultFixture(input, 'CHILD_WORK_UNPROVEN'),
      }),
    },
  },
  play: async (context) => {
    const confirm = await chooseAction(context, 'Abandon');
    await userEvent.click(confirm.getByRole('button', { name: 'Abandon run' }));
    await expect(await confirm.findByText("Abandon wasn't applied")).toBeVisible();
  },
};

export const Abandoned: Story = {
  parameters: { trpc: { handlers: handlersFor('heldAfterTurn') } },
  play: async (context) => {
    const confirm = await chooseAction(context, 'Abandon');
    await userEvent.click(confirm.getByRole('button', { name: 'Abandon run' }));
    await expect(await within(context.canvasElement).findByText('Run abandoned.')).toBeVisible();
  },
};

export const Retried: Story = {
  parameters: { trpc: { handlers: handlersFor('heldAfterTurn') } },
  play: async (context) => {
    const confirm = await chooseAction(context, 'Retry');
    await userEvent.click(confirm.getByRole('button', { name: 'Retry run' }));
    await expect(await within(context.canvasElement).findByText('Retry started.')).toBeVisible();
  },
};

/** The run finished between loading the list and opening Inspect. */
export const AlreadyFinished: Story = {
  parameters: {
    trpc: {
      handlers: handlersFor('deliveryUncertain', {
        'automation.recoveryTarget': () => unavailableTargetFixture('run-deliveryUncertain'),
      }),
    },
  },
  play: async (context) => {
    const dialog = await inspect(context);
    await expect(await dialog.findByText(/already finished/)).toBeVisible();
  },
};

export const ArchivedProject: Story = {
  args: { archived: true },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole('button', { name: 'Inspect' })
    ).toBeDisabled();
  },
};

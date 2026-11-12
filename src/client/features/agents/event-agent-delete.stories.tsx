import type { Meta, StoryObj } from '@storybook/react';
import { TRPCError } from '@trpc/server';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { Loading } from '@/client/components/loading';
import { trpc } from '@/client/lib/trpc';
import { managedAgentSchema } from '@/shared/agent-management';
import { EventAgentDetail } from './event-agent-detail';
import { eventAgentFixture, triggerInBackendState } from './event-agent.test-support';
import type { EventAgent } from './types';

const base = eventAgentFixture();
// A listening automation, with the backend's exact fields for an ACTIVE trigger.
const listening = managedAgentSchema.parse({
  ...base,
  isEnabled: true,
  configuredTriggers: base.configuredTriggers.map((trigger) => ({
    ...triggerInBackendState(trigger, 'ACTIVE'),
    activationGeneration: 1,
  })),
});
// The server's refusal while a claimed run is unfinished; nothing is changed.
const unfinished =
  '1 run of this automation has started and not finished. Let it finish, or stop it in the ' +
  'workspace (or abandon it from the Runs view if it needs attention), then delete the ' +
  'automation again. Nothing was changed.';

const handlers = {
  'automation.get': ({ agentId }: { agentId: string }) => {
    if (agentId !== listening.id) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Automation not found in this project.' });
    }
    return listening;
  },
  'automation.delete': () => ({ deleted: true }),
};

/** The saved detail as the page shows it; a delete returns to the list. */
function DeletableEventDetail({
  agent,
  archived = false,
}: {
  agent: EventAgent;
  archived?: boolean;
}) {
  const [deleted, setDeleted] = useState(false);
  const query = trpc.automation.get.useQuery(
    { projectId: agent.projectId, agentId: agent.id },
    { enabled: !deleted }
  );
  if (deleted) {
    return (
      <main className="mx-auto min-w-0 max-w-3xl p-4">
        <p role="status">Back on the automations list.</p>
      </main>
    );
  }
  if (!query.data) {
    return <Loading size="compact" message="Loading automation…" />;
  }
  return (
    <main className="mx-auto min-w-0 max-w-3xl p-4">
      <EventAgentDetail
        agent={query.data}
        archived={archived}
        onEdit={() => undefined}
        onDeleted={() => setDeleted(true)}
      />
    </main>
  );
}

const meta = {
  title: 'Automations/EventAutomationDelete',
  component: DeletableEventDetail,
  parameters: { layout: 'fullscreen', trpc: { handlers } },
  args: { agent: listening },
} satisfies Meta<typeof DeletableEventDetail>;
export default meta;
type Story = StoryObj<typeof meta>;

async function openDialog(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: 'Delete' }));
  return within(within(canvasElement.ownerDocument.body).getByRole('alertdialog'));
}

export const DeleteControl: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Delete' })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: 'Pause' })).toBeEnabled();
  },
};
export const ConfirmDialog: Story = {
  play: async ({ canvasElement }) => {
    const dialog = await openDialog(canvasElement);
    await expect(dialog.getByText(/its triggers, its run and event history/)).toBeVisible();
    await expect(dialog.getByText(/Workspaces its runs started are kept/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Delete automation' })).toBeEnabled();
  },
};
export const Deleted: Story = {
  play: async ({ canvasElement }) => {
    const dialog = await openDialog(canvasElement);
    await userEvent.click(dialog.getByRole('button', { name: 'Delete automation' }));
    await expect(await within(canvasElement).findByRole('status')).toHaveTextContent(
      'Back on the automations list.'
    );
  },
};
export const RefusedWhileRunUnfinished: Story = {
  parameters: {
    trpc: {
      handlers: {
        ...handlers,
        'automation.delete': () => {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: unfinished });
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const dialog = await openDialog(canvasElement);
    await userEvent.click(dialog.getByRole('button', { name: 'Delete automation' }));
    const alert = await dialog.findByRole('alert');
    await expect(alert).toHaveTextContent("Couldn't delete this automation.");
    await expect(alert).toHaveTextContent('Let it finish, or stop it in the workspace');
  },
};
export const Conflict: Story = {
  parameters: {
    trpc: {
      handlers: {
        ...handlers,
        'automation.delete': () => {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This automation changed. Reload it and try again.',
          });
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const dialog = await openDialog(canvasElement);
    await userEvent.click(dialog.getByRole('button', { name: 'Delete automation' }));
    await expect(await dialog.findByRole('button', { name: 'Reload automation' })).toBeVisible();
    await expect(dialog.getByText('This automation changed since it was loaded.')).toBeVisible();
  },
};
export const Archived: Story = {
  args: { archived: true },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole('button', { name: 'Delete' })
    ).toBeDisabled();
  },
};
export const PhoneConfirmDialog: Story = {
  ...ConfirmDialog,
  globals: { viewport: { value: 'phone', isRotated: false } },
};
export const ConfirmDialogDark: Story = { ...ConfirmDialog, globals: { theme: 'dark' } };

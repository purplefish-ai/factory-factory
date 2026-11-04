import type { Meta, StoryObj } from '@storybook/react';
import { useLocation } from 'react-router';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { EventAgentCreate } from '@/client/features/agents/event-agent-create';
import { discardWorkspaceCreationDraft } from '@/client/features/kanban/workspace-creation-draft-storage';
import { STORY_TRPC_PENDING } from '@/client/lib/storybook-trpc';
import { EventAgentWorkspaceForm } from './event-agent-workspace-form';
import { eventWorkspaceHandlers } from './event-agent-workspace-form.story-fixtures';

function EventCreation() {
  const location = useLocation();
  return (
    <EventAgentCreate>
      <output aria-label="Current location">{location.pathname}</output>
      <EventAgentWorkspaceForm
        projectId="event-create-story"
        projectSlug="factory"
        onCancel={() => undefined}
      />
    </EventAgentCreate>
  );
}
const meta = {
  title: 'Agents/EventAgentCreation',
  component: EventCreation,
  beforeEach: async () => {
    finishCreation = undefined;
    await discardWorkspaceCreationDraft('event-agent:event-create-story');
  },
  parameters: { trpc: { handlers: eventWorkspaceHandlers } },
} satisfies Meta<typeof EventCreation>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const prompt = await canvas.findByRole('textbox');
    await expect(prompt).toHaveProperty('value', expect.stringContaining('propose_agent'));
    await waitFor(() => expect(prompt).toBeEnabled());
    await expect(
      canvas.getByText(/Listening and automatic event runs are not yet available/)
    ).toBeVisible();
    await userEvent.clear(prompt);
    await userEvent.type(prompt, 'Propose an agent that reviews labeled issues.');
    await expect(prompt).toHaveValue('Propose an agent that reviews labeled issues.');
    await expect(
      canvas.queryByRole('button', { name: 'Choose launch mode' })
    ).not.toBeInTheDocument();
  },
};
export const Phone: Story = {
  ...Ready,
  globals: { viewport: { value: 'phone', isRotated: false } },
};

let finishCreation: ((failure?: boolean) => void) | undefined;
function settleCreation(failure = false) {
  if (!finishCreation) {
    throw new Error('No workspace creation is pending');
  }
  finishCreation(failure);
  finishCreation = undefined;
}
const pendingCreation = () =>
  new Promise((resolve, reject) => {
    finishCreation = (failure) => {
      if (failure) {
        reject(new Error('Worktree creation failed'));
      } else {
        resolve({
          id: 'event-workspace',
          projectId: 'event-create-story',
          name: 'Event authoring',
          status: 'NEW',
          ratchetEnabled: false,
          createdAt: new Date('2026-11-04T12:00:00Z'),
        });
      }
    };
  });
async function startPendingCreation(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const prompt = await canvas.findByRole('textbox');
  await waitFor(() => expect(prompt).toBeEnabled());
  await userEvent.clear(prompt);
  await userEvent.type(prompt, 'Create my event authoring workspace');
  const launch = canvas.getByRole('button', { name: 'Launch' });
  await waitFor(() => expect(launch).toBeEnabled());
  await userEvent.click(launch);
  await expect(await canvas.findByRole('status', { name: '' })).toHaveTextContent(
    'Creating event agent workspace…'
  );
  await expect(canvas.getByRole('status', { name: '' })).toBeVisible();
  await expect(canvas.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  await waitFor(() => expect(typeof finishCreation).toBe('function'));
  return canvas;
}
export const PendingSuccess: Story = {
  parameters: {
    trpc: { handlers: { ...eventWorkspaceHandlers, 'workspace.create': pendingCreation } },
  },
  play: async ({ canvasElement }) => {
    const canvas = await startPendingCreation(canvasElement);
    settleCreation();
    await waitFor(() =>
      expect(canvas.getByLabelText('Current location')).toHaveTextContent(
        '/projects/factory/workspaces/event-workspace'
      )
    );
    await expect(canvas.queryByRole('status', { name: '' })).not.toBeInTheDocument();
  },
};
export const PendingFailure: Story = {
  parameters: PendingSuccess.parameters,
  play: async ({ canvasElement }) => {
    const canvas = await startPendingCreation(canvasElement);
    settleCreation(true);
    await waitFor(() => expect(canvas.getByRole('textbox')).toBeEnabled());
    await expect(canvas.getByRole('textbox')).toHaveValue('Create my event authoring workspace');
    await expect(canvas.getByRole('alert')).toHaveTextContent('Worktree creation failed');
    await expect(canvas.queryByRole('status', { name: '' })).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Launch' })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Launch' }));
    await expect(await canvas.findByRole('status', { name: '' })).toBeVisible();
    await waitFor(() => expect(typeof finishCreation).toBe('function'));
    settleCreation();
    await waitFor(() =>
      expect(canvas.getByLabelText('Current location')).toHaveTextContent(
        '/projects/factory/workspaces/event-workspace'
      )
    );
  },
};

export const PendingPhone: Story = {
  ...PendingSuccess,
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const CodexSelection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const picker = await canvas.findByRole('button', {
      name: /New conversation provider and model: Claude/,
    });
    await waitFor(() => expect(picker).toBeEnabled());
    await userEvent.click(picker);
    await userEvent.click(
      within(canvasElement.ownerDocument.body).getByRole('menuitem', { name: /Codex/ })
    );
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Launch' })).toBeEnabled());
    await expect(
      canvas.getByRole('button', { name: /New conversation provider and model: Codex/ })
    ).toBeVisible();
  },
};
export const WorkspaceNamesLoading: Story = {
  parameters: {
    trpc: {
      handlers: { ...eventWorkspaceHandlers, 'workspace.listForProject': () => STORY_TRPC_PENDING },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Loading workspace names…')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Launch' })).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  },
};
let namesUnavailable = true;
export const WorkspaceNamesFailure: Story = {
  beforeEach: () => {
    namesUnavailable = true;
  },
  parameters: {
    trpc: {
      handlers: {
        ...eventWorkspaceHandlers,
        'workspace.listForProject': () => {
          if (namesUnavailable) {
            throw new Error('Names unavailable');
          }
          return { workspaces: [], reviewCount: 0 };
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      "Couldn't load workspace names"
    );
    await expect(canvas.queryByRole('button', { name: 'Launch' })).not.toBeInTheDocument();
    namesUnavailable = false;
    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }));
    await expect(await canvas.findByRole('textbox')).toBeVisible();
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Launch' })).toBeEnabled());
  },
};

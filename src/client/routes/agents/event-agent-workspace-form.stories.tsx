import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { EventAgentCreate } from '@/client/features/agents/event-agent-create';
import { discardWorkspaceCreationDraft } from '@/client/features/kanban/workspace-creation-draft-storage';
import { EventAgentWorkspaceForm } from './event-agent-workspace-form';
import { eventWorkspaceHandlers } from './event-agent-workspace-form.story-fixtures';

function EventCreation() {
  return (
    <EventAgentCreate>
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

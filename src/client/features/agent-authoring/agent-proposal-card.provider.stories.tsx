import type { Meta, StoryObj } from '@storybook/react';
import { TRPCError } from '@trpc/server';
import { expect, within } from 'storybook/test';
import { agentProposalSchema } from '@/shared/agent-proposal';
import { AgentProposalCard } from './agent-proposal-card';

const reference = {
  type: 'automation_proposal' as const,
  workspaceId: 'workspace-1',
  proposalId: 'proposal-1',
};
// What `automation.getProposal` returns once the proposal created an automation.
const accepted = agentProposalSchema.parse({
  id: reference.proposalId,
  workspaceId: reference.workspaceId,
  revision: 1,
  agentDefinitionId: 'agent-1',
  sourceNames: {},
  specification: {
    name: 'Investigate labeled issues',
    instructions: 'Investigate labeled issues and propose a focused fix.',
    executionConfig: { version: 1 },
    triggers: [
      {
        id: 'local-github',
        type: 'GITHUB_ISSUE',
        connectionId: 'github-connection',
        description: 'Investigate labeled issues',
        config: { version: 1, repositoryIds: ['repo-1'], actions: ['labeled'], labels: ['agent'] },
      },
    ],
  },
});

const meta = {
  title: 'Chat/Prompts/AutomationProposalCardWithData',
  component: AgentProposalCard,
  args: { reference },
  parameters: { trpc: { handlers: { 'automation.getProposal': () => accepted } } },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-3xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AgentProposalCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CreatedAutomation: Story = {
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText(/Automation created/)).toBeVisible();
  },
};
/** Deleting a saved automation also deletes the proposal that created it. */
export const AutomationDeleted: Story = {
  parameters: {
    trpc: {
      handlers: {
        'automation.getProposal': () => {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Automation proposal not found in this workspace.',
          });
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('alert')).toHaveTextContent(
      'This automation proposal is no longer available.'
    );
  },
};

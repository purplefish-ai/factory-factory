import type { Meta, StoryObj } from '@storybook/react';
import { agentProposalSchema, type AgentProposal } from '@/shared/agent-proposal';
import { AgentProposalEditor } from './agent-proposal-card';

const proposal = agentProposalSchema.parse({
  id: 'proposal-1',
  workspaceId: 'workspace-1',
  revision: 1,
  agentDefinitionId: null,
  sourceNames: {
    'slack-1:C-feedback': '#customer-feedback',
    'slack-1:C-review': '#fillet-packet-review',
  },
  specification: {
    name: 'Feedback investigator',
    instructions:
      'Investigate reported bugs in the development database. Summarize the evidence and proposed fix in the original Slack thread.',
    triggers: [
      {
        type: 'SLACK_MESSAGE',
        connectionId: 'slack-1',
        description: 'Messages in #customer-feedback, including thread replies.',
        filterInstructions:
          'Investigate automated bug reports and human reports. Ignore ordinary conversation. When uncertain, investigate.',
        config: {
          version: 1,
          channelIds: ['C-feedback'],
          context: { includeThread: true, nearbyMessageCount: 5 },
        },
      },
    ],
  },
});
function proposalArgs(fixture: AgentProposal) {
  const onCreate: Parameters<typeof AgentProposalEditor>[0]['onCreate'] = (input) =>
    Promise.resolve({
      ...fixture,
      specification: input.specification,
      agentDefinitionId: fixture.agentDefinitionId ?? 'agent-1',
    });
  return { proposal: fixture, onCreate };
}

const meta = {
  title: 'Chat/Agent proposal',
  component: AgentProposalEditor,
  parameters: { layout: 'padded' },
  args: proposalArgs(proposal),
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AgentProposalEditor>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Feedback: Story = {};
export const PacketReview: Story = {
  args: proposalArgs(
    agentProposalSchema.parse({
      ...proposal,
      specification: {
        name: 'Packet QA reviewer',
        instructions: 'Compare the QA edits after a packet unlock and investigate potential bugs.',
        triggers: [
          {
            type: 'SLACK_MESSAGE',
            connectionId: 'slack-1',
            description: 'Packet unlock messages in review threads.',
            filterInstructions:
              'The message announces that the packet was unlocked and QA is complete.',
            config: {
              version: 1,
              channelIds: ['C-review'],
              context: { includeThread: true, nearbyMessageCount: 0 },
            },
          },
        ],
      },
    })
  ),
};
export const GitHub: Story = {
  args: proposalArgs(
    agentProposalSchema.parse({
      ...proposal,
      sourceNames: { 'github-1:123': 'purplefish-ai/factory-factory' },
      specification: {
        name: 'Agent issue executor',
        instructions: 'Implement the requested fix and open a PR.',
        triggers: [
          {
            type: 'GITHUB_ISSUE',
            connectionId: 'github-1',
            description: 'Issues created with, or later given, the agent label.',
            config: {
              version: 1,
              repositoryIds: ['123'],
              actions: ['opened', 'labeled'],
              labels: ['agent'],
            },
          },
        ],
      },
    })
  ),
};
export const Created: Story = { args: proposalArgs({ ...proposal, agentDefinitionId: 'agent-1' }) };
export const Failure: Story = {
  args: {
    onCreate: () =>
      Promise.reject(
        new Error('This Slack connection was disconnected. Reconnect it and try again.')
      ),
  },
};
export const Creating: Story = { args: { onCreate: () => new Promise(() => undefined) } };

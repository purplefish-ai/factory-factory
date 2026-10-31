import { expect, it } from 'vitest';
import { extractAgentProposal } from './agent-proposal-result';

const payload = {
  type: 'agent_proposal',
  proposalId: 'proposal-1',
  workspaceId: 'workspace-1',
  revision: 2,
};
it('recognizes a proposal in text blocks and nested MCP envelopes', () => {
  expect(
    extractAgentProposal(
      [
        {
          type: 'text',
          text: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(payload) }] }),
        },
      ],
      'mcp__factory-factory-child-workspace__propose_agent'
    )
  ).toEqual(payload);
});
it('ignores malformed references and proposal-looking output from other tools', () => {
  expect(extractAgentProposal(JSON.stringify(payload), 'Bash')).toBeNull();
  expect(
    extractAgentProposal(JSON.stringify({ type: 'agent_proposal' }), 'propose_agent')
  ).toBeNull();
  expect(extractAgentProposal('plain text', 'propose_agent')).toBeNull();
});
it('recognizes the dotted tool name and raw result envelope emitted by the installed Codex ACP adapter', () => {
  expect(
    extractAgentProposal(
      JSON.stringify({
        result: {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: null,
          _meta: null,
        },
        error: null,
      }),
      'mcp.factory-factory-child-workspace.propose_agent'
    )
  ).toEqual(payload);
});

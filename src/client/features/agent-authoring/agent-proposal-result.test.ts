import { expect, it } from 'vitest';
import { extractAgentProposal } from './agent-proposal-result';

const payload = {
  type: 'automation_proposal',
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
      'mcp__factory-factory-child-workspace__propose_automation'
    )
  ).toEqual(payload);
});
it('ignores malformed references and proposal-looking output from other tools', () => {
  expect(extractAgentProposal(JSON.stringify(payload), 'Bash')).toBeNull();
  expect(
    extractAgentProposal(JSON.stringify({ type: 'automation_proposal' }), 'propose_automation')
  ).toBeNull();
  expect(extractAgentProposal('plain text', 'propose_automation')).toBeNull();
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
      'mcp.factory-factory-child-workspace.propose_automation'
    )
  ).toEqual(payload);
});

it.each(['propose_agent', 'get_agent_proposal'])(
  'renders persisted proposals from the legacy %s tool',
  (toolName) => {
    const legacy = { ...payload, type: 'agent_proposal' };
    expect(extractAgentProposal(JSON.stringify(legacy), toolName)).toEqual(legacy);
  }
);
it.each(['propose_automation', 'get_automation_proposal'])(
  'recognizes all supported MCP name formats for %s',
  (toolName) => {
    for (const name of [
      toolName,
      `mcp__factory-factory-child-workspace__${toolName}`,
      `mcp.factory-factory-child-workspace.${toolName}`,
      `factory-factory-child-workspace/${toolName}`,
    ]) {
      expect(extractAgentProposal(JSON.stringify(payload), name)).toEqual(payload);
    }
  }
);

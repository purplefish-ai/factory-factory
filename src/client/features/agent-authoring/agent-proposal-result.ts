import type { ToolResultContentValue } from '@/lib/chat-protocol';
import { agentProposalReferenceSchema, type AgentProposalReference } from '@/shared/agent-proposal';

const proposalTools = new Set(
  ['propose_agent', 'get_agent_proposal'].flatMap((name) => [
    name,
    `mcp__factory-factory-child-workspace__${name}`,
    `mcp.factory-factory-child-workspace.${name}`,
    `factory-factory-child-workspace/${name}`,
  ])
);

function search(value: unknown, depth = 0): AgentProposalReference | null {
  if (depth > 12) {
    return null;
  }
  const parsed = agentProposalReferenceSchema.strip().safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  if (typeof value === 'string') {
    try {
      const json: unknown = JSON.parse(value);
      return search(json, depth + 1);
    } catch {
      return null;
    }
  }
  const children = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.values(value)
      : [];
  for (const item of children) {
    const found = search(item, depth + 1);
    if (found) {
      return found;
    }
  }
  return null;
}

export function extractAgentProposal(content: ToolResultContentValue, toolName?: string) {
  if (!(toolName && proposalTools.has(toolName))) {
    return null;
  }
  return search(content);
}

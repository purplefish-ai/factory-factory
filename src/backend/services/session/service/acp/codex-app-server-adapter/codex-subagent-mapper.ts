import {
  SUBAGENT_TOOL_META_KEY,
  subagentToolMetadataSchema,
} from '@/shared/acp-protocol/subagents';
import { collabAgentToolCallItemSchema, subAgentActivityItemSchema } from './codex-zod';

export type SubagentToolMapping = {
  title: string;
  kind: 'other';
  locations: [];
  meta?: Record<string, unknown>;
  affectedSubagentIds: string[];
};

export function mapCodexSubagentToolItem(
  item: { type: string; id: string } & Record<string, unknown>,
  parentSessionId: string
): SubagentToolMapping | null {
  const subAgentActivity = subAgentActivityItemSchema.safeParse(item);
  if (subAgentActivity.success) {
    const { agentPath, agentThreadId, kind } = subAgentActivity.data;
    return {
      title: formatSubagentActivityTitle(kind, getSubagentName(agentPath)),
      kind: 'other',
      locations: [],
      affectedSubagentIds: [agentThreadId],
      meta: createSubagentMeta(agentThreadId, parentSessionId),
    };
  }

  const collabAgentToolCall = collabAgentToolCallItemSchema.safeParse(item);
  if (!collabAgentToolCall.success) {
    return null;
  }

  const { receiverThreadIds, tool } = collabAgentToolCall.data;
  const childId = receiverThreadIds.length === 1 ? receiverThreadIds[0] : undefined;
  return {
    title: tool,
    kind: 'other',
    locations: [],
    affectedSubagentIds: receiverThreadIds,
    ...(childId ? { meta: createSubagentMeta(childId, parentSessionId) } : {}),
  };
}

function getSubagentName(agentPath: string): string {
  return agentPath.split('/').filter(Boolean).at(-1) ?? 'subagent';
}

function formatSubagentActivityTitle(
  kind: 'started' | 'interacted' | 'interrupted',
  name: string
): string {
  switch (kind) {
    case 'started':
      return `Start subagent ${name}`;
    case 'interacted':
      return `Interact with subagent ${name}`;
    case 'interrupted':
      return `Interrupt subagent ${name}`;
  }
}

function createSubagentMeta(childId: string, parentSessionId: string): Record<string, unknown> {
  const metadata = subagentToolMetadataSchema.parse({
    id: childId,
    parentSessionId,
  });

  return {
    [SUBAGENT_TOOL_META_KEY]: metadata,
  };
}

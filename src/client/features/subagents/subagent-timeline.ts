import { getSubagentIconIndices } from '@/client/lib/subagent-icon-indices';
import type { ChatMessage } from '@/lib/chat-protocol';
import type { SubagentSummary } from '@/shared/acp-protocol';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

/** Project provider-owned lifecycle evidence without persisting synthetic chat messages. */
export function createSubagentTimelineEvents(subagents: SubagentSummary[]): ChatMessage[] {
  const events = new Map<string, ChatMessage>();
  const iconIndices = getSubagentIconIndices(subagents);
  for (const agent of subagents) {
    const name = agent.name?.trim() || 'Sub-agent';
    const append = (phase: 'started' | 'finished', timestamp: string | null, label: string) => {
      if (!(timestamp && Number.isFinite(Date.parse(timestamp)))) {
        return;
      }
      const id = `subagent-${agent.id}-${phase}`;
      events.set(id, {
        id,
        order: 0,
        subagentIconIndex: iconIndices.get(agent.id),
        source: 'agent',
        timestamp,
        text: `${name} ${label}`,
        message: {
          type: 'system',
          subtype: `subagent_${phase}`,
          text: `${name} ${label}`,
          status: phase === 'started' ? 'running' : agent.status,
        },
      });
    };
    append('started', agent.createdAt, 'started working');
    if (TERMINAL_STATUSES.has(agent.status)) {
      append('finished', agent.completedAt ?? agent.updatedAt, terminalLabel(agent.status));
    }
  }
  return [...events.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

function transcriptTimestamp(message: ChatMessage): number {
  const providerTime = Date.parse(message.message?.timestamp ?? '');
  return Number.isFinite(providerTime) ? providerTime : Date.parse(message.timestamp);
}

/** Merge stable event objects while preserving transcript order and identity. */
export function mergeSubagentTimeline(
  messages: ChatMessage[],
  pending: ChatMessage[]
): ChatMessage[] {
  if (pending.length === 0) {
    return messages;
  }
  const merged: ChatMessage[] = [];
  let index = 0;
  for (const message of messages) {
    // Preserve transcript order, including provider messages with identical timestamps.
    while (index < pending.length) {
      const event = pending[index];
      if (!event || Date.parse(event.timestamp) > transcriptTimestamp(message)) {
        break;
      }
      merged.push(event);
      index += 1;
    }
    merged.push(message);
  }
  merged.push(...pending.slice(index));
  return merged;
}

function terminalLabel(status: SubagentSummary['status']): string {
  return status === 'completed' ? 'finished' : status;
}

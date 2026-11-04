import { getSubagentIconIndices } from '@/client/lib/subagent-icon-indices';
import type { ChatMessage } from '@/lib/chat-protocol';
import type { SubagentSummary } from '@/shared/acp-protocol';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

// Chat messages are immutable, so their parsed times can be cached by identity.
// Streaming replaces only the changed message, letting each merge reuse the rest.
const eventTimes = new WeakMap<ChatMessage, number>();
const transcriptTimes = new WeakMap<ChatMessage, number>();

/** Project provider-owned lifecycle evidence without persisting synthetic chat messages. */
export function createSubagentTimelineEvents(subagents: SubagentSummary[]): ChatMessage[] {
  const events = new Map<string, ChatMessage>();
  const iconIndices = getSubagentIconIndices(subagents);
  for (const agent of subagents) {
    const name = agent.name?.trim() || 'Subagent';
    const append = (phase: 'started' | 'finished', timestamp: string | null, label: string) => {
      const time = timestamp ? Date.parse(timestamp) : Number.NaN;
      if (!(timestamp && Number.isFinite(time))) {
        return;
      }
      const id = `subagent-${agent.id}-${phase}`;
      const event: ChatMessage = {
        id,
        subagentId: agent.id,
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
      };
      eventTimes.set(event, time);
      events.set(id, event);
    };
    append('started', agent.createdAt, 'started working');
    if (TERMINAL_STATUSES.has(agent.status)) {
      append('finished', agent.completedAt ?? agent.updatedAt, terminalLabel(agent.status));
    }
  }
  return [...events.values()].sort((a, b) => eventTime(a) - eventTime(b));
}

function eventTime(event: ChatMessage): number {
  let time = eventTimes.get(event);
  if (time === undefined) {
    time = Date.parse(event.timestamp);
    eventTimes.set(event, time);
  }
  return time;
}

function transcriptTimestamp(message: ChatMessage): number {
  let time = transcriptTimes.get(message);
  if (time === undefined) {
    const providerTime = Date.parse(message.message?.timestamp ?? '');
    time = Number.isFinite(providerTime) ? providerTime : Date.parse(message.timestamp);
    transcriptTimes.set(message, time);
  }
  return time;
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
  let nextEvent = pending[0];
  let nextEventTime = nextEvent ? eventTime(nextEvent) : Number.NaN;
  for (const message of messages) {
    // Preserve transcript order, including provider messages with identical timestamps.
    // `!(event > message)` also places events before rows whose time cannot be parsed.
    if (nextEvent) {
      const messageTime = transcriptTimestamp(message);
      while (nextEvent && !(nextEventTime > messageTime)) {
        merged.push(nextEvent);
        index += 1;
        nextEvent = pending[index];
        nextEventTime = nextEvent ? eventTime(nextEvent) : Number.NaN;
      }
    }
    merged.push(message);
  }
  merged.push(...pending.slice(index));
  return merged;
}

function terminalLabel(status: SubagentSummary['status']): string {
  return status === 'completed' ? 'finished' : status;
}

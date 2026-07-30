import type { SessionLifecycleEventRecord } from '@/backend/services/session/resources/session-lifecycle-event.accessor';
import type { ChatMessage } from '@/shared/acp-protocol';

type IndexedMessage = {
  message: ChatMessage;
  originalIndex: number;
  isLifecycle: boolean;
  timestampMs: number;
};

export function toLifecycleChatMessage(event: SessionLifecycleEventRecord): ChatMessage {
  const timestamp = event.createdAt.toISOString();
  return {
    id: `session-lifecycle:${event.id}`,
    source: 'agent',
    timestamp,
    order: 0,
    message: {
      type: 'session_lifecycle',
      timestamp,
      lifecycle: {
        eventId: event.id,
        kind: event.kind,
        reason: event.reason,
        message: event.message,
        timestamp,
      },
    },
  };
}

export function mergeLifecycleTranscript(
  transcript: ChatMessage[],
  events: SessionLifecycleEventRecord[]
): ChatMessage[] {
  if (events.length === 0) {
    return transcript;
  }
  return mergeLifecycleMessage(transcript, events.map(toLifecycleChatMessage));
}

export function mergeLifecycleMessage(
  transcript: ChatMessage[],
  lifecycleMessages: ChatMessage | ChatMessage[]
): ChatMessage[] {
  const additions = Array.isArray(lifecycleMessages) ? lifecycleMessages : [lifecycleMessages];
  if (additions.length === 0) {
    return transcript;
  }

  const toIndexedMessage = (message: ChatMessage, originalIndex: number): IndexedMessage => {
    const parsedTimestamp = Date.parse(message.timestamp);
    return {
      message,
      originalIndex,
      isLifecycle: message.message?.type === 'session_lifecycle',
      timestampMs: Number.isNaN(parsedTimestamp) ? Number.POSITIVE_INFINITY : parsedTimestamp,
    };
  };

  const byId = new Map(
    transcript.map((message, index) => [message.id, toIndexedMessage(message, index)])
  );
  for (const lifecycleMessage of additions) {
    const existing = byId.get(lifecycleMessage.id);
    byId.set(
      lifecycleMessage.id,
      toIndexedMessage(lifecycleMessage, existing?.originalIndex ?? byId.size)
    );
  }

  const sortedMessages = [...byId.values()].sort(compareIndexedMessages);
  return assignLifecycleOrders(sortedMessages);
}

function assignLifecycleOrders(sortedMessages: IndexedMessage[]): ChatMessage[] {
  const providerMessages = sortedMessages.filter(({ isLifecycle }) => !isLifecycle);
  if (providerMessages.length === 0) {
    const lifecycleCount = sortedMessages.length;
    return sortedMessages.map(({ message }, index) => ({
      ...message,
      order: (index + 1) / (lifecycleCount + 1),
    }));
  }

  const lifecycleMessagesByProviderIndex = groupLifecycleMessages(sortedMessages);

  for (const [providerIndex, messages] of lifecycleMessagesByProviderIndex) {
    const [lowerOrder, upperOrder] = lifecycleOrderBounds(providerMessages, providerIndex);
    const interval = upperOrder - lowerOrder;
    messages.forEach((indexedMessage, index) => {
      indexedMessage.message = {
        ...indexedMessage.message,
        order: lowerOrder + (interval * (index + 1)) / (messages.length + 1),
      };
    });
  }

  return sortedMessages.map(({ message }) => message);
}

function groupLifecycleMessages(sortedMessages: IndexedMessage[]): Map<number, IndexedMessage[]> {
  const groups = new Map<number, IndexedMessage[]>();
  let precedingProviderCount = 0;
  for (const indexedMessage of sortedMessages) {
    if (!indexedMessage.isLifecycle) {
      precedingProviderCount += 1;
      continue;
    }
    const providerIndex = precedingProviderCount === 0 ? -1 : precedingProviderCount - 1;
    const messages = groups.get(providerIndex) ?? [];
    messages.push(indexedMessage);
    groups.set(providerIndex, messages);
  }
  return groups;
}

function lifecycleOrderBounds(
  providerMessages: IndexedMessage[],
  providerIndex: number
): [number, number] {
  const isBeforeFirstProvider = providerIndex === -1;
  const firstProviderOrder = providerMessages[0]?.message.order ?? 0;
  const lowerOrder = isBeforeFirstProvider
    ? firstProviderOrder - 1
    : (providerMessages[providerIndex]?.message.order ?? firstProviderOrder);
  const nextProviderOrder = isBeforeFirstProvider
    ? firstProviderOrder
    : providerMessages[providerIndex + 1]?.message.order;
  return [
    lowerOrder,
    nextProviderOrder !== undefined && nextProviderOrder > lowerOrder
      ? nextProviderOrder
      : lowerOrder + 1,
  ];
}

function compareIndexedMessages(left: IndexedMessage, right: IndexedMessage): number {
  if (left.timestampMs !== right.timestampMs) {
    return left.timestampMs - right.timestampMs;
  }
  if (left.isLifecycle !== right.isLifecycle) {
    return left.isLifecycle ? 1 : -1;
  }
  if (left.isLifecycle) {
    return left.message.id.localeCompare(right.message.id);
  }
  return left.originalIndex - right.originalIndex;
}

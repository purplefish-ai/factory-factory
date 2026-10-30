import type { SessionLifecycleEventRecord } from '@/backend/services/session/resources/session-lifecycle-event.accessor';
import type { ChatMessage } from '@/shared/acp-protocol';
import { isLocalTranscriptMessage } from './session-local-transcript';

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
      isLifecycle: isLocalTranscriptMessage(message),
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

  const providerMessages: IndexedMessage[] = [];
  const localMessages: IndexedMessage[] = [];
  for (const indexedMessage of byId.values()) {
    (indexedMessage.isLifecycle ? localMessages : providerMessages).push(indexedMessage);
  }
  // Provider messages keep their transcript order: a message queued during a reply keeps its
  // enqueue timestamp but is committed after the reply, so timestamps are not order-sorted.
  providerMessages.sort(compareProviderMessages);
  localMessages.sort(compareLifecycleMessages);
  return assignLifecycleOrders(providerMessages, localMessages);
}

function assignLifecycleOrders(
  providerMessages: IndexedMessage[],
  lifecycleMessages: IndexedMessage[]
): ChatMessage[] {
  if (providerMessages.length === 0) {
    const lifecycleCount = lifecycleMessages.length;
    return lifecycleMessages.map(({ message }, index) => ({
      ...message,
      order: (index + 1) / (lifecycleCount + 1),
    }));
  }

  const lifecycleMessagesByProviderIndex = groupLifecycleMessages(
    providerMessages,
    lifecycleMessages
  );

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

  const merged: ChatMessage[] = [];
  const pushLifecycle = (providerIndex: number) => {
    for (const { message } of lifecycleMessagesByProviderIndex.get(providerIndex) ?? []) {
      merged.push(message);
    }
  };
  pushLifecycle(-1);
  providerMessages.forEach(({ message }, providerIndex) => {
    merged.push(message);
    pushLifecycle(providerIndex);
  });
  return merged;
}

/**
 * Places each lifecycle message after the last provider message (in transcript order) whose
 * timestamp is not later than the lifecycle message, or before every provider message (-1).
 */
function groupLifecycleMessages(
  providerMessages: IndexedMessage[],
  lifecycleMessages: IndexedMessage[]
): Map<number, IndexedMessage[]> {
  // suffixMinTimestamp[i] is non-decreasing, and the last index whose suffix minimum is <= t is
  // exactly the last provider message whose own timestamp is <= t.
  const suffixMinTimestamp = new Array<number>(providerMessages.length);
  let minTimestamp = Number.POSITIVE_INFINITY;
  for (let index = providerMessages.length - 1; index >= 0; index -= 1) {
    minTimestamp = Math.min(minTimestamp, providerMessages[index]?.timestampMs ?? minTimestamp);
    suffixMinTimestamp[index] = minTimestamp;
  }

  const groups = new Map<number, IndexedMessage[]>();
  for (const indexedMessage of lifecycleMessages) {
    const providerIndex = lastIndexAtOrBefore(suffixMinTimestamp, indexedMessage.timestampMs);
    const messages = groups.get(providerIndex) ?? [];
    messages.push(indexedMessage);
    groups.set(providerIndex, messages);
  }
  return groups;
}

function lastIndexAtOrBefore(sortedValues: number[], value: number): number {
  let low = 0;
  let high = sortedValues.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sortedValues[middle] ?? Number.POSITIVE_INFINITY) <= value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low - 1;
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

function compareProviderMessages(left: IndexedMessage, right: IndexedMessage): number {
  if (left.message.order !== right.message.order) {
    return left.message.order - right.message.order;
  }
  return left.originalIndex - right.originalIndex;
}

function compareLifecycleMessages(left: IndexedMessage, right: IndexedMessage): number {
  if (left.timestampMs !== right.timestampMs) {
    return left.timestampMs - right.timestampMs;
  }
  return left.message.id.localeCompare(right.message.id);
}

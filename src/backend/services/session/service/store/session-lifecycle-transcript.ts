import type { SessionLifecycleEventRecord } from '@/backend/services/session/resources/session-lifecycle-event.accessor';
import type { ChatMessage } from '@/shared/acp-protocol';

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

  type IndexedMessage = {
    message: ChatMessage;
    originalIndex: number;
    isLifecycle: boolean;
    timestampMs: number;
  };
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

  return [...byId.values()]
    .sort((left, right) => {
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
    })
    .map(({ message }, order) => ({ ...message, order }));
}

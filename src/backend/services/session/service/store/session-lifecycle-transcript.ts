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
  const byId = new Map(transcript.map((message) => [message.id, message]));
  for (const event of events) {
    const lifecycleMessage = toLifecycleChatMessage(event);
    byId.set(lifecycleMessage.id, lifecycleMessage);
  }
  return [...byId.values()]
    .sort(
      (left, right) =>
        left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id)
    )
    .map((message, order) => ({ ...message, order }));
}

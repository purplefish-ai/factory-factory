import { expect } from 'vitest';
import type { WebSocketMessage } from '@/shared/acp-protocol';
import { MessageState } from '@/shared/acp-protocol';

/**
 * Replays published session events into the ids a viewer would render after
 * each one: queue placeholders plus committed or dispatched transcript entries.
 * Snapshots are not expected on these paths.
 */
export function visibleIdsAfterEachEvent(payloads: WebSocketMessage[], initialQueue: string[]) {
  let queued = initialQueue;
  const transcript = new Set<string>();
  const committed: string[] = [];
  const states: Array<{ visible: string[]; queued: string[]; committed: string[] }> = [];
  for (const payload of payloads) {
    expect(payload.type).not.toBe('session_snapshot');
    if (payload.type !== 'session_delta') {
      continue;
    }
    const event = payload.data;
    if (event.type === 'queue_updated' || event.type === 'transcript_message_committed') {
      queued = event.queuedMessages.map(({ id }) => id);
      for (const id of queued) {
        transcript.delete(id);
      }
    }
    if (event.type === 'transcript_message_committed') {
      transcript.add(event.chatMessage.id);
      committed.push(event.chatMessage.id);
    }
    if (
      event.type === 'message_state_changed' &&
      event.id &&
      (event.newState === MessageState.DISPATCHED || event.newState === MessageState.COMMITTED) &&
      event.userMessage?.order !== undefined
    ) {
      const id = event.id;
      transcript.add(id);
      queued = queued.filter((queuedId) => queuedId !== id);
    }
    states.push({ visible: [...transcript, ...queued], queued, committed: [...committed] });
  }
  return states;
}

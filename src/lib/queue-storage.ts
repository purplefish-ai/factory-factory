/**
 * Session-storage based queue persistence for chat messages.
 * Messages are stored per-session to persist across page reloads.
 */

import type { QueuedMessage } from './claude-types';

const QUEUE_KEY_PREFIX = 'chat-queue-';

/**
 * Validate that an object has the required QueuedMessage shape.
 */
function isValidQueuedMessage(obj: unknown): obj is QueuedMessage {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof (obj as QueuedMessage).id === 'string' &&
    typeof (obj as QueuedMessage).text === 'string' &&
    typeof (obj as QueuedMessage).timestamp === 'string'
  );
}

/**
 * Load queued messages from sessionStorage for a specific session.
 */
export function loadQueue(dbSessionId: string): QueuedMessage[] {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const stored = sessionStorage.getItem(`${QUEUE_KEY_PREFIX}${dbSessionId}`);
    if (!stored) {
      return [];
    }
    const parsed: unknown = JSON.parse(stored);
    // Validate the parsed data has the expected shape
    if (!Array.isArray(parsed)) {
      return [];
    }
    // Filter out any malformed entries
    return parsed.filter(isValidQueuedMessage);
  } catch {
    return [];
  }
}

/**
 * Persist queued messages to sessionStorage for a specific session.
 * Clears storage if queue is empty.
 */
export function persistQueue(dbSessionId: string | null, messages: QueuedMessage[]): void {
  if (typeof window === 'undefined' || !dbSessionId) {
    return;
  }
  try {
    if (messages.length === 0) {
      sessionStorage.removeItem(`${QUEUE_KEY_PREFIX}${dbSessionId}`);
    } else {
      sessionStorage.setItem(`${QUEUE_KEY_PREFIX}${dbSessionId}`, JSON.stringify(messages));
    }
  } catch {
    // Silently ignore storage errors (quota exceeded, etc.)
  }
}

/**
 * Session-storage based persistence for chat messages and settings.
 * Data is stored per-session to persist across page reloads and tab switches.
 */

import type { ChatSettings, QueuedMessage } from './claude-types';

const QUEUE_KEY_PREFIX = 'chat-queue-';
const SETTINGS_KEY_PREFIX = 'chat-settings-';

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

/**
 * Validate that an object has the required ChatSettings shape.
 */
function isValidChatSettings(obj: unknown): obj is ChatSettings {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }
  const settings = obj as ChatSettings;
  return (
    (settings.selectedModel === null || typeof settings.selectedModel === 'string') &&
    typeof settings.thinkingEnabled === 'boolean' &&
    typeof settings.planModeEnabled === 'boolean'
  );
}

/**
 * Load chat settings from sessionStorage for a specific session.
 * Returns null if no settings are stored (caller should use defaults).
 */
export function loadSettings(dbSessionId: string): ChatSettings | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const stored = sessionStorage.getItem(`${SETTINGS_KEY_PREFIX}${dbSessionId}`);
    if (!stored) {
      return null;
    }
    const parsed: unknown = JSON.parse(stored);
    if (!isValidChatSettings(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist chat settings to sessionStorage for a specific session.
 */
export function persistSettings(dbSessionId: string | null, settings: ChatSettings): void {
  if (typeof window === 'undefined' || !dbSessionId) {
    return;
  }
  try {
    sessionStorage.setItem(`${SETTINGS_KEY_PREFIX}${dbSessionId}`, JSON.stringify(settings));
  } catch {
    // Silently ignore storage errors (quota exceeded, etc.)
  }
}

/**
 * Clear chat settings from sessionStorage for a specific session.
 */
export function clearSettings(dbSessionId: string | null): void {
  if (typeof window === 'undefined' || !dbSessionId) {
    return;
  }
  try {
    sessionStorage.removeItem(`${SETTINGS_KEY_PREFIX}${dbSessionId}`);
  } catch {
    // Silently ignore storage errors
  }
}

/**
 * Chat persistence utilities for localStorage/sessionStorage.
 *
 * This module handles persisting and loading:
 * - Chat settings (model, thinking mode, plan mode)
 * - Input drafts (preserved across tab switches)
 *
 * Note: Message queue is now managed on the backend. Queue state is restored
 * via session_snapshot WebSocket event, not frontend persistence.
 *
 * Settings use sessionStorage (per-tab persistence).
 * Drafts use sessionStorage keyed by session ID.
 */

import type { ChatSettings } from '@/lib/chat-protocol';
import { DEFAULT_CHAT_SETTINGS } from '@/lib/chat-protocol';

// =============================================================================
// Storage Keys
// =============================================================================

const DRAFT_KEY_PREFIX = 'chat-draft-';
const SETTINGS_KEY_PREFIX = 'chat-settings-';

// =============================================================================
// Draft Persistence
// =============================================================================

/**
 * Get the sessionStorage key for a draft.
 */
function getDraftKey(sessionId: string): string {
  return `${DRAFT_KEY_PREFIX}${sessionId}`;
}

/**
 * Load draft from sessionStorage for a specific session.
 */
export function loadDraft(sessionId: string | null): string {
  if (!sessionId || typeof window === 'undefined') {
    return '';
  }
  try {
    return sessionStorage.getItem(getDraftKey(sessionId)) ?? '';
  } catch {
    return '';
  }
}

/**
 * Persist draft to sessionStorage for a specific session.
 * Clears the draft if it's empty.
 */
export function persistDraft(sessionId: string | null, draft: string): void {
  if (!sessionId || typeof window === 'undefined') {
    return;
  }
  try {
    if (draft.trim()) {
      sessionStorage.setItem(getDraftKey(sessionId), draft);
    } else {
      sessionStorage.removeItem(getDraftKey(sessionId));
    }
  } catch {
    // Silently ignore storage errors
  }
}

/**
 * Clear draft from sessionStorage for a specific session.
 */
export function clearDraft(sessionId: string | null): void {
  if (!sessionId || typeof window === 'undefined') {
    return;
  }
  try {
    sessionStorage.removeItem(getDraftKey(sessionId));
  } catch {
    // Silently ignore storage errors
  }
}

// =============================================================================
// Settings Persistence
// =============================================================================

/**
 * Validate that an object has the required ChatSettings shape.
 */
function isValidChatSettings(obj: unknown): obj is ChatSettings {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }
  const settings = obj as Partial<ChatSettings>;
  return (
    (settings.selectedModel === null || typeof settings.selectedModel === 'string') &&
    (settings.reasoningEffort === undefined ||
      settings.reasoningEffort === null ||
      typeof settings.reasoningEffort === 'string') &&
    typeof settings.thinkingEnabled === 'boolean' &&
    typeof settings.planModeEnabled === 'boolean'
  );
}

/**
 * Load chat settings from sessionStorage for a specific session.
 * Returns null if no settings are stored (caller should use defaults).
 */
export function loadSettings(sessionId: string | null): ChatSettings | null {
  if (!sessionId || typeof window === 'undefined') {
    return null;
  }
  try {
    const stored = sessionStorage.getItem(`${SETTINGS_KEY_PREFIX}${sessionId}`);
    if (!stored) {
      return null;
    }
    const parsed: unknown = JSON.parse(stored);
    if (!isValidChatSettings(parsed)) {
      return null;
    }
    return {
      selectedModel: parsed.selectedModel,
      reasoningEffort: parsed.reasoningEffort ?? null,
      thinkingEnabled: parsed.thinkingEnabled,
      planModeEnabled: parsed.planModeEnabled,
    };
  } catch {
    return null;
  }
}

/**
 * Persist chat settings to sessionStorage for a specific session.
 */
export function persistSettings(sessionId: string | null, settings: ChatSettings): void {
  if (!sessionId || typeof window === 'undefined') {
    return;
  }
  try {
    sessionStorage.setItem(`${SETTINGS_KEY_PREFIX}${sessionId}`, JSON.stringify(settings));
  } catch {
    // Silently ignore storage errors
  }
}

/**
 * Clear chat settings from sessionStorage for a specific session.
 */
export function clearSettings(sessionId: string | null): void {
  if (!sessionId || typeof window === 'undefined') {
    return;
  }
  try {
    sessionStorage.removeItem(`${SETTINGS_KEY_PREFIX}${sessionId}`);
  } catch {
    // Silently ignore storage errors
  }
}

/**
 * Load settings with fallback to defaults.
 */
export function loadSettingsWithDefaults(sessionId: string | null): ChatSettings {
  const stored = loadSettings(sessionId);
  return stored ?? DEFAULT_CHAT_SETTINGS;
}

// =============================================================================
// Session Cleanup
// =============================================================================

/**
 * Clear all persisted data for a specific session.
 * Call this when switching sessions to avoid stale data.
 */
export function clearAllSessionData(sessionId: string | null): void {
  clearDraft(sessionId);
  clearSettings(sessionId);
}

/**
 * Load all persisted data for a session.
 * Returns an object with all session-related persisted state.
 *
 * Note: Queue is managed on the backend and restored via WebSocket.
 */
export interface PersistedSessionData {
  draft: string;
  settings: ChatSettings;
}

export function loadAllSessionData(sessionId: string | null): PersistedSessionData {
  return {
    draft: loadDraft(sessionId),
    settings: loadSettingsWithDefaults(sessionId),
  };
}

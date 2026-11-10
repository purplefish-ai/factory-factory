/**
 * Chat persistence utilities for sessionStorage.
 *
 * This module handles persisting and loading:
 * - Chat settings (model, thinking mode, plan mode)
 * - Input drafts (preserved across tab switches)
 * - Input attachments (preserved across tab switches/reloads)
 *
 * Note: Message queue is now managed on the backend. Queue state is restored
 * via session_snapshot WebSocket event, not frontend persistence.
 *
 * Settings use sessionStorage (per-tab persistence).
 * Drafts and input attachments use sessionStorage keyed by session ID.
 */

import {
  readStorageItem,
  readStoredJson,
  removeStorageItem,
  writeStorageItem,
  writeStoredJson,
} from '@/client/lib/browser-storage';
import type { ChatSettings, MessageAttachment } from '@/lib/chat-protocol';
import { DEFAULT_CHAT_SETTINGS, resolveSelectedModel } from '@/lib/chat-protocol';
import { AttachmentSchema, ChatSettingsSchema } from '@/shared/websocket';

// =============================================================================
// Storage Keys
// =============================================================================

const DRAFT_KEY_PREFIX = 'chat-draft-';
const ATTACHMENTS_KEY_PREFIX = 'chat-attachments-';
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
 * Get the sessionStorage key for input attachments.
 */
function getAttachmentsKey(sessionId: string): string {
  return `${ATTACHMENTS_KEY_PREFIX}${sessionId}`;
}

/**
 * Load draft from sessionStorage for a specific session.
 */
export function loadDraft(sessionId: string | null): string {
  return sessionId ? (readStorageItem(getDraftKey(sessionId), 'session') ?? '') : '';
}

/**
 * Persist draft to sessionStorage for a specific session.
 * Clears the draft if it's empty. Storage failures are ignored.
 */
export function persistDraft(sessionId: string | null, draft: string): void {
  if (!sessionId) {
    return;
  }
  if (draft.trim()) {
    writeStorageItem(getDraftKey(sessionId), draft, 'session');
  } else {
    removeStorageItem(getDraftKey(sessionId), 'session');
  }
}

/**
 * Clear draft from sessionStorage for a specific session.
 */
export function clearDraft(sessionId: string | null): void {
  if (sessionId) {
    removeStorageItem(getDraftKey(sessionId), 'session');
  }
}

// =============================================================================
// Input Attachment Persistence
// =============================================================================

const PersistedAttachmentsSchema = AttachmentSchema.array();

export type InputAttachmentsPersistenceResult =
  | { ok: true; operation: 'save' | 'clear' | 'skip' }
  | { ok: false; operation: 'save' | 'clear' };

/**
 * Load input attachments from sessionStorage for a specific session.
 */
export function loadInputAttachments(sessionId: string | null): MessageAttachment[] {
  if (!sessionId) {
    return [];
  }
  return readStoredJson(getAttachmentsKey(sessionId), PersistedAttachmentsSchema, 'session') ?? [];
}

/**
 * Persist input attachments to sessionStorage for a specific session.
 * Clears persisted attachments if the list is empty.
 */
export function persistInputAttachments(
  sessionId: string | null,
  attachments: MessageAttachment[]
): InputAttachmentsPersistenceResult {
  if (!sessionId) {
    return { ok: true, operation: 'skip' };
  }
  const operation = attachments.length > 0 ? 'save' : 'clear';
  const ok =
    attachments.length > 0
      ? writeStoredJson(getAttachmentsKey(sessionId), attachments, 'session')
      : removeStorageItem(getAttachmentsKey(sessionId), 'session');
  return { ok, operation };
}

/**
 * Clear persisted input attachments for a specific session.
 */
export function clearInputAttachments(sessionId: string | null): InputAttachmentsPersistenceResult {
  if (!sessionId) {
    return { ok: true, operation: 'skip' };
  }
  return { ok: removeStorageItem(getAttachmentsKey(sessionId), 'session'), operation: 'clear' };
}

// =============================================================================
// Settings Persistence
// =============================================================================

const PersistedChatSettingsSchema = ChatSettingsSchema.partial({ reasoningEffort: true }).transform(
  (settings) => ({
    ...settings,
    selectedModel: resolveSelectedModel(settings.selectedModel),
    reasoningEffort: settings.reasoningEffort ?? null,
  })
);

/**
 * Load chat settings from sessionStorage for a specific session.
 * Returns null if no settings are stored (caller should use defaults).
 */
export function loadSettings(sessionId: string | null): ChatSettings | null {
  if (!sessionId) {
    return null;
  }
  return (
    readStoredJson(`${SETTINGS_KEY_PREFIX}${sessionId}`, PersistedChatSettingsSchema, 'session') ??
    null
  );
}

/**
 * Persist chat settings to sessionStorage for a specific session.
 */
export function persistSettings(sessionId: string | null, settings: ChatSettings): void {
  if (sessionId) {
    writeStoredJson(`${SETTINGS_KEY_PREFIX}${sessionId}`, settings, 'session');
  }
}

/**
 * Clear chat settings from sessionStorage for a specific session.
 */
export function clearSettings(sessionId: string | null): void {
  if (sessionId) {
    removeStorageItem(`${SETTINGS_KEY_PREFIX}${sessionId}`, 'session');
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
  clearInputAttachments(sessionId);
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
  inputAttachments: MessageAttachment[];
  settings: ChatSettings;
}

export function loadAllSessionData(sessionId: string | null): PersistedSessionData {
  return {
    draft: loadDraft(sessionId),
    inputAttachments: loadInputAttachments(sessionId),
    settings: loadSettingsWithDefaults(sessionId),
  };
}

/**
 * Tests for the chat persistence utilities module.
 *
 * Note: These tests verify the persistence logic without browser APIs.
 * The actual sessionStorage integration is tested by mocking the storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSettings, QueuedMessage } from '@/lib/claude-types';
import { DEFAULT_CHAT_SETTINGS } from '@/lib/claude-types';
import {
  clearAllSessionData,
  clearDraft,
  clearQueue,
  clearSettings,
  loadAllSessionData,
  loadDraft,
  loadQueue,
  loadSettings,
  loadSettingsWithDefaults,
  persistDraft,
  persistQueue,
  persistSettings,
} from './chat-persistence';

// =============================================================================
// Mock sessionStorage
// =============================================================================

const mockStorage = new Map<string, string>();

const mockSessionStorage = {
  getItem: vi.fn((key: string) => mockStorage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => mockStorage.set(key, value)),
  removeItem: vi.fn((key: string) => mockStorage.delete(key)),
  clear: vi.fn(() => mockStorage.clear()),
  get length() {
    return mockStorage.size;
  },
  key: vi.fn((index: number) => {
    const keys = Array.from(mockStorage.keys());
    return keys[index] ?? null;
  }),
};

// Mock window.sessionStorage
beforeEach(() => {
  mockStorage.clear();
  vi.stubGlobal('sessionStorage', mockSessionStorage);
  vi.stubGlobal('window', { sessionStorage: mockSessionStorage });
});

afterEach(() => {
  vi.unstubAllGlobals();
  mockStorage.clear();
  vi.clearAllMocks();
});

// =============================================================================
// Draft Persistence Tests
// =============================================================================

describe('draft persistence', () => {
  describe('loadDraft', () => {
    it('should return empty string for null sessionId', () => {
      const result = loadDraft(null);
      expect(result).toBe('');
    });

    it('should return empty string when no draft exists', () => {
      const result = loadDraft('session-123');
      expect(result).toBe('');
    });

    it('should return stored draft', () => {
      mockStorage.set('chat-draft-session-123', 'My draft message');
      const result = loadDraft('session-123');
      expect(result).toBe('My draft message');
    });

    it('should return empty string on storage error', () => {
      mockSessionStorage.getItem.mockImplementationOnce(() => {
        throw new Error('Storage error');
      });
      const result = loadDraft('session-123');
      expect(result).toBe('');
    });
  });

  describe('persistDraft', () => {
    it('should not persist for null sessionId', () => {
      persistDraft(null, 'My draft');
      expect(mockSessionStorage.setItem).not.toHaveBeenCalled();
    });

    it('should persist non-empty draft', () => {
      persistDraft('session-123', 'My draft message');
      expect(mockStorage.get('chat-draft-session-123')).toBe('My draft message');
    });

    it('should remove draft when empty', () => {
      mockStorage.set('chat-draft-session-123', 'Old draft');
      persistDraft('session-123', '');
      expect(mockStorage.has('chat-draft-session-123')).toBe(false);
    });

    it('should remove draft when whitespace only', () => {
      mockStorage.set('chat-draft-session-123', 'Old draft');
      persistDraft('session-123', '   ');
      expect(mockStorage.has('chat-draft-session-123')).toBe(false);
    });

    it('should silently handle storage errors', () => {
      mockSessionStorage.setItem.mockImplementationOnce(() => {
        throw new Error('Storage full');
      });
      // Should not throw
      expect(() => persistDraft('session-123', 'My draft')).not.toThrow();
    });
  });

  describe('clearDraft', () => {
    it('should not clear for null sessionId', () => {
      clearDraft(null);
      expect(mockSessionStorage.removeItem).not.toHaveBeenCalled();
    });

    it('should remove draft from storage', () => {
      mockStorage.set('chat-draft-session-123', 'My draft');
      clearDraft('session-123');
      expect(mockStorage.has('chat-draft-session-123')).toBe(false);
    });

    it('should silently handle storage errors', () => {
      mockSessionStorage.removeItem.mockImplementationOnce(() => {
        throw new Error('Storage error');
      });
      expect(() => clearDraft('session-123')).not.toThrow();
    });
  });
});

// =============================================================================
// Settings Persistence Tests
// =============================================================================

describe('settings persistence', () => {
  describe('loadSettings', () => {
    it('should return null for null sessionId', () => {
      const result = loadSettings(null);
      expect(result).toBeNull();
    });

    it('should return null when no settings exist', () => {
      const result = loadSettings('session-123');
      expect(result).toBeNull();
    });

    it('should return stored settings', () => {
      const settings: ChatSettings = {
        selectedModel: 'opus',
        thinkingEnabled: true,
        planModeEnabled: false,
      };
      mockStorage.set('chat-settings-session-123', JSON.stringify(settings));
      const result = loadSettings('session-123');
      expect(result).toEqual(settings);
    });

    it('should return null for invalid JSON', () => {
      mockStorage.set('chat-settings-session-123', 'not json');
      const result = loadSettings('session-123');
      expect(result).toBeNull();
    });

    it('should return null for invalid settings shape', () => {
      mockStorage.set('chat-settings-session-123', JSON.stringify({ foo: 'bar' }));
      const result = loadSettings('session-123');
      expect(result).toBeNull();
    });

    it('should return null for settings with wrong types', () => {
      mockStorage.set(
        'chat-settings-session-123',
        JSON.stringify({
          selectedModel: 123, // should be string or null
          thinkingEnabled: 'true', // should be boolean
          planModeEnabled: false,
        })
      );
      const result = loadSettings('session-123');
      expect(result).toBeNull();
    });

    it('should accept settings with null selectedModel', () => {
      const settings: ChatSettings = {
        selectedModel: null,
        thinkingEnabled: false,
        planModeEnabled: true,
      };
      mockStorage.set('chat-settings-session-123', JSON.stringify(settings));
      const result = loadSettings('session-123');
      expect(result).toEqual(settings);
    });

    it('should return null on storage error', () => {
      mockSessionStorage.getItem.mockImplementationOnce(() => {
        throw new Error('Storage error');
      });
      const result = loadSettings('session-123');
      expect(result).toBeNull();
    });
  });

  describe('persistSettings', () => {
    it('should not persist for null sessionId', () => {
      persistSettings(null, DEFAULT_CHAT_SETTINGS);
      expect(mockSessionStorage.setItem).not.toHaveBeenCalled();
    });

    it('should persist settings as JSON', () => {
      const settings: ChatSettings = {
        selectedModel: 'sonnet',
        thinkingEnabled: true,
        planModeEnabled: false,
      };
      persistSettings('session-123', settings);
      const stored = mockStorage.get('chat-settings-session-123');
      expect(stored).toBeDefined();
      expect(JSON.parse(stored ?? '')).toEqual(settings);
    });

    it('should silently handle storage errors', () => {
      mockSessionStorage.setItem.mockImplementationOnce(() => {
        throw new Error('Storage full');
      });
      expect(() => persistSettings('session-123', DEFAULT_CHAT_SETTINGS)).not.toThrow();
    });
  });

  describe('clearSettings', () => {
    it('should not clear for null sessionId', () => {
      clearSettings(null);
      expect(mockSessionStorage.removeItem).not.toHaveBeenCalled();
    });

    it('should remove settings from storage', () => {
      mockStorage.set('chat-settings-session-123', JSON.stringify(DEFAULT_CHAT_SETTINGS));
      clearSettings('session-123');
      expect(mockStorage.has('chat-settings-session-123')).toBe(false);
    });

    it('should silently handle storage errors', () => {
      mockSessionStorage.removeItem.mockImplementationOnce(() => {
        throw new Error('Storage error');
      });
      expect(() => clearSettings('session-123')).not.toThrow();
    });
  });

  describe('loadSettingsWithDefaults', () => {
    it('should return defaults for null sessionId', () => {
      const result = loadSettingsWithDefaults(null);
      expect(result).toEqual(DEFAULT_CHAT_SETTINGS);
    });

    it('should return defaults when no settings stored', () => {
      const result = loadSettingsWithDefaults('session-123');
      expect(result).toEqual(DEFAULT_CHAT_SETTINGS);
    });

    it('should return stored settings when valid', () => {
      const settings: ChatSettings = {
        selectedModel: 'opus',
        thinkingEnabled: true,
        planModeEnabled: true,
      };
      mockStorage.set('chat-settings-session-123', JSON.stringify(settings));
      const result = loadSettingsWithDefaults('session-123');
      expect(result).toEqual(settings);
    });

    it('should return defaults for invalid stored settings', () => {
      mockStorage.set('chat-settings-session-123', 'invalid json');
      const result = loadSettingsWithDefaults('session-123');
      expect(result).toEqual(DEFAULT_CHAT_SETTINGS);
    });
  });
});

// =============================================================================
// Queue Persistence Tests
// =============================================================================

describe('queue persistence', () => {
  describe('loadQueue', () => {
    it('should return empty array for null sessionId', () => {
      const result = loadQueue(null);
      expect(result).toEqual([]);
    });

    it('should return empty array when no queue exists', () => {
      const result = loadQueue('session-123');
      expect(result).toEqual([]);
    });

    it('should return stored queue', () => {
      const queue: QueuedMessage[] = [
        { id: 'q-1', text: 'First', timestamp: '2024-01-01T00:00:00.000Z' },
        { id: 'q-2', text: 'Second', timestamp: '2024-01-01T00:00:01.000Z' },
      ];
      mockStorage.set('chat-queue-session-123', JSON.stringify(queue));
      const result = loadQueue('session-123');
      expect(result).toEqual(queue);
    });

    it('should return empty array for invalid JSON', () => {
      mockStorage.set('chat-queue-session-123', 'not json');
      const result = loadQueue('session-123');
      expect(result).toEqual([]);
    });

    it('should return empty array for non-array JSON', () => {
      mockStorage.set('chat-queue-session-123', JSON.stringify({ not: 'array' }));
      const result = loadQueue('session-123');
      expect(result).toEqual([]);
    });

    it('should filter out malformed queue entries', () => {
      const mixedQueue = [
        { id: 'q-1', text: 'Valid', timestamp: '2024-01-01T00:00:00.000Z' },
        { id: 'q-2', text: 123, timestamp: '2024-01-01T00:00:00.000Z' }, // text is not string
        { id: 'q-3', timestamp: '2024-01-01T00:00:00.000Z' }, // missing text
        { text: 'Missing id', timestamp: '2024-01-01T00:00:00.000Z' }, // missing id
        { id: 'q-5', text: 'Valid 2', timestamp: '2024-01-01T00:00:01.000Z' },
      ];
      mockStorage.set('chat-queue-session-123', JSON.stringify(mixedQueue));
      const result = loadQueue('session-123');
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('q-1');
      expect(result[1].id).toBe('q-5');
    });

    it('should return empty array on storage error', () => {
      mockSessionStorage.getItem.mockImplementationOnce(() => {
        throw new Error('Storage error');
      });
      const result = loadQueue('session-123');
      expect(result).toEqual([]);
    });
  });

  describe('persistQueue', () => {
    it('should not persist for null sessionId', () => {
      persistQueue(null, []);
      expect(mockSessionStorage.setItem).not.toHaveBeenCalled();
    });

    it('should persist non-empty queue as JSON', () => {
      const queue: QueuedMessage[] = [
        { id: 'q-1', text: 'Message', timestamp: '2024-01-01T00:00:00.000Z' },
      ];
      persistQueue('session-123', queue);
      const stored = mockStorage.get('chat-queue-session-123');
      expect(stored).toBeDefined();
      expect(JSON.parse(stored ?? '')).toEqual(queue);
    });

    it('should remove storage when queue is empty', () => {
      mockStorage.set('chat-queue-session-123', JSON.stringify([{ id: 'old' }]));
      persistQueue('session-123', []);
      expect(mockStorage.has('chat-queue-session-123')).toBe(false);
    });

    it('should silently handle storage errors', () => {
      mockSessionStorage.setItem.mockImplementationOnce(() => {
        throw new Error('Storage full');
      });
      expect(() =>
        persistQueue('session-123', [
          { id: 'q-1', text: 'Test', timestamp: '2024-01-01T00:00:00.000Z' },
        ])
      ).not.toThrow();
    });
  });

  describe('clearQueue', () => {
    it('should not clear for null sessionId', () => {
      clearQueue(null);
      expect(mockSessionStorage.removeItem).not.toHaveBeenCalled();
    });

    it('should remove queue from storage', () => {
      mockStorage.set('chat-queue-session-123', JSON.stringify([{ id: 'q-1' }]));
      clearQueue('session-123');
      expect(mockStorage.has('chat-queue-session-123')).toBe(false);
    });

    it('should silently handle storage errors', () => {
      mockSessionStorage.removeItem.mockImplementationOnce(() => {
        throw new Error('Storage error');
      });
      expect(() => clearQueue('session-123')).not.toThrow();
    });
  });
});

// =============================================================================
// Session Cleanup Tests
// =============================================================================

describe('session cleanup', () => {
  describe('clearAllSessionData', () => {
    it('should not clear anything for null sessionId', () => {
      clearAllSessionData(null);
      expect(mockSessionStorage.removeItem).not.toHaveBeenCalled();
    });

    it('should clear draft, settings, and queue for session', () => {
      mockStorage.set('chat-draft-session-123', 'draft');
      mockStorage.set('chat-settings-session-123', JSON.stringify(DEFAULT_CHAT_SETTINGS));
      mockStorage.set('chat-queue-session-123', JSON.stringify([]));

      clearAllSessionData('session-123');

      expect(mockStorage.has('chat-draft-session-123')).toBe(false);
      expect(mockStorage.has('chat-settings-session-123')).toBe(false);
      expect(mockStorage.has('chat-queue-session-123')).toBe(false);
    });
  });

  describe('loadAllSessionData', () => {
    it('should return defaults for null sessionId', () => {
      const result = loadAllSessionData(null);
      expect(result).toEqual({
        draft: '',
        settings: DEFAULT_CHAT_SETTINGS,
        queue: [],
      });
    });

    it('should return defaults when nothing stored', () => {
      const result = loadAllSessionData('session-123');
      expect(result).toEqual({
        draft: '',
        settings: DEFAULT_CHAT_SETTINGS,
        queue: [],
      });
    });

    it('should return all stored data', () => {
      const settings: ChatSettings = {
        selectedModel: 'sonnet',
        thinkingEnabled: true,
        planModeEnabled: false,
      };
      const queue: QueuedMessage[] = [
        { id: 'q-1', text: 'Message', timestamp: '2024-01-01T00:00:00.000Z' },
      ];

      mockStorage.set('chat-draft-session-123', 'My draft');
      mockStorage.set('chat-settings-session-123', JSON.stringify(settings));
      mockStorage.set('chat-queue-session-123', JSON.stringify(queue));

      const result = loadAllSessionData('session-123');

      expect(result.draft).toBe('My draft');
      expect(result.settings).toEqual(settings);
      expect(result.queue).toEqual(queue);
    });

    it('should return partial data when some items invalid', () => {
      mockStorage.set('chat-draft-session-123', 'My draft');
      mockStorage.set('chat-settings-session-123', 'invalid json'); // Invalid
      mockStorage.set('chat-queue-session-123', JSON.stringify([]));

      const result = loadAllSessionData('session-123');

      expect(result.draft).toBe('My draft');
      expect(result.settings).toEqual(DEFAULT_CHAT_SETTINGS); // Falls back to defaults
      expect(result.queue).toEqual([]);
    });
  });
});

// =============================================================================
// Edge Cases Tests
// =============================================================================

describe('edge cases', () => {
  it('should handle special characters in draft', () => {
    const draft = 'Hello "world" with \'quotes\' and\nnewlines\tand\ttabs';
    persistDraft('session-123', draft);
    const result = loadDraft('session-123');
    expect(result).toBe(draft);
  });

  it('should handle unicode characters in draft', () => {
    const draft = 'Hello World!';
    persistDraft('session-123', draft);
    const result = loadDraft('session-123');
    expect(result).toBe(draft);
  });

  it('should handle very long draft', () => {
    const draft = 'a'.repeat(10_000);
    persistDraft('session-123', draft);
    const result = loadDraft('session-123');
    expect(result).toBe(draft);
  });

  it('should handle session IDs with special characters', () => {
    const sessionId = 'session-with-special-chars-123_abc';
    const draft = 'Test draft';
    persistDraft(sessionId, draft);
    expect(loadDraft(sessionId)).toBe(draft);
  });

  it('should handle different session IDs independently', () => {
    persistDraft('session-1', 'Draft 1');
    persistDraft('session-2', 'Draft 2');

    expect(loadDraft('session-1')).toBe('Draft 1');
    expect(loadDraft('session-2')).toBe('Draft 2');
    expect(loadDraft('session-3')).toBe('');
  });
});

// =============================================================================
// Storage Key Format Tests
// =============================================================================

describe('storage key format', () => {
  it('should use chat-draft- prefix for drafts', () => {
    persistDraft('session-abc', 'draft');
    expect(mockStorage.has('chat-draft-session-abc')).toBe(true);
  });

  it('should use chat-settings- prefix for settings', () => {
    persistSettings('session-abc', DEFAULT_CHAT_SETTINGS);
    expect(mockStorage.has('chat-settings-session-abc')).toBe(true);
  });

  it('should use chat-queue- prefix for queue', () => {
    persistQueue('session-abc', [
      { id: 'q-1', text: 'test', timestamp: '2024-01-01T00:00:00.000Z' },
    ]);
    expect(mockStorage.has('chat-queue-session-abc')).toBe(true);
  });
});

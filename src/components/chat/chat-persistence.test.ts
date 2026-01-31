/**
 * Tests for the chat persistence utilities module.
 *
 * Note: These tests verify the persistence logic without browser APIs.
 * The actual sessionStorage integration is tested by mocking the storage.
 *
 * Message queue persistence has been removed - queue is now managed on the backend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSettings } from '@/lib/claude-types';
import { DEFAULT_CHAT_SETTINGS } from '@/lib/claude-types';
import {
  clearAllSessionData,
  clearDraft,
  clearSettings,
  loadAllSessionData,
  loadDraft,
  loadSettings,
  loadSettingsWithDefaults,
  persistDraft,
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

    it('should accept settings with default selectedModel', () => {
      const settings: ChatSettings = {
        selectedModel: 'opus',
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
// Session Cleanup Tests
// =============================================================================

describe('session cleanup', () => {
  describe('clearAllSessionData', () => {
    it('should not clear anything for null sessionId', () => {
      clearAllSessionData(null);
      expect(mockSessionStorage.removeItem).not.toHaveBeenCalled();
    });

    it('should clear draft and settings for session', () => {
      mockStorage.set('chat-draft-session-123', 'draft');
      mockStorage.set('chat-settings-session-123', JSON.stringify(DEFAULT_CHAT_SETTINGS));

      clearAllSessionData('session-123');

      expect(mockStorage.has('chat-draft-session-123')).toBe(false);
      expect(mockStorage.has('chat-settings-session-123')).toBe(false);
    });
  });

  describe('loadAllSessionData', () => {
    it('should return defaults for null sessionId', () => {
      const result = loadAllSessionData(null);
      expect(result).toEqual({
        draft: '',
        settings: DEFAULT_CHAT_SETTINGS,
      });
    });

    it('should return defaults when nothing stored', () => {
      const result = loadAllSessionData('session-123');
      expect(result).toEqual({
        draft: '',
        settings: DEFAULT_CHAT_SETTINGS,
      });
    });

    it('should return all stored data', () => {
      const settings: ChatSettings = {
        selectedModel: 'sonnet',
        thinkingEnabled: true,
        planModeEnabled: false,
      };

      mockStorage.set('chat-draft-session-123', 'My draft');
      mockStorage.set('chat-settings-session-123', JSON.stringify(settings));

      const result = loadAllSessionData('session-123');

      expect(result.draft).toBe('My draft');
      expect(result.settings).toEqual(settings);
    });

    it('should return partial data when some items invalid', () => {
      mockStorage.set('chat-draft-session-123', 'My draft');
      mockStorage.set('chat-settings-session-123', 'invalid json'); // Invalid

      const result = loadAllSessionData('session-123');

      expect(result.draft).toBe('My draft');
      expect(result.settings).toEqual(DEFAULT_CHAT_SETTINGS); // Falls back to defaults
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
});

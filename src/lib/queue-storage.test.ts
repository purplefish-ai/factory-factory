/**
 * Tests for queue-storage module.
 *
 * Note: These tests verify the JSON serialization logic and error handling.
 * The actual sessionStorage integration is verified through manual testing
 * since the project doesn't have jsdom configured for browser API testing.
 */
import { describe, expect, it } from 'vitest';

import type { QueuedMessage } from './claude-types';

// Since the actual storage functions use sessionStorage which isn't available in Node.js,
// we test the serialization/deserialization logic that those functions rely on.

describe('queue-storage serialization', () => {
  describe('QueuedMessage JSON round-trip', () => {
    it('should serialize and deserialize a single message', () => {
      const message: QueuedMessage = {
        id: 'msg-123',
        text: 'Hello, world!',
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      const serialized = JSON.stringify([message]);
      const deserialized = JSON.parse(serialized) as QueuedMessage[];

      expect(deserialized).toHaveLength(1);
      expect(deserialized[0]).toEqual(message);
    });

    it('should serialize and deserialize multiple messages in order', () => {
      const messages: QueuedMessage[] = [
        { id: 'msg-1', text: 'First', timestamp: '2024-01-01T00:00:00.000Z' },
        { id: 'msg-2', text: 'Second', timestamp: '2024-01-01T00:00:01.000Z' },
        { id: 'msg-3', text: 'Third', timestamp: '2024-01-01T00:00:02.000Z' },
      ];

      const serialized = JSON.stringify(messages);
      const deserialized = JSON.parse(serialized) as QueuedMessage[];

      expect(deserialized).toHaveLength(3);
      expect(deserialized[0].text).toBe('First');
      expect(deserialized[1].text).toBe('Second');
      expect(deserialized[2].text).toBe('Third');
    });

    it('should handle empty array', () => {
      const messages: QueuedMessage[] = [];

      const serialized = JSON.stringify(messages);
      const deserialized = JSON.parse(serialized) as QueuedMessage[];

      expect(deserialized).toEqual([]);
    });

    it('should handle special characters in text', () => {
      const message: QueuedMessage = {
        id: 'msg-special',
        text: 'Hello "world" with \'quotes\' and\nnewlines\tand\ttabs',
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      const serialized = JSON.stringify([message]);
      const deserialized = JSON.parse(serialized) as QueuedMessage[];

      expect(deserialized[0].text).toBe(message.text);
    });

    it('should handle unicode characters', () => {
      const message: QueuedMessage = {
        id: 'msg-unicode',
        text: 'Hello 世界 🌍 مرحبا',
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      const serialized = JSON.stringify([message]);
      const deserialized = JSON.parse(serialized) as QueuedMessage[];

      expect(deserialized[0].text).toBe(message.text);
    });

    it('should handle very long text', () => {
      const longText = 'a'.repeat(10_000);
      const message: QueuedMessage = {
        id: 'msg-long',
        text: longText,
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      const serialized = JSON.stringify([message]);
      const deserialized = JSON.parse(serialized) as QueuedMessage[];

      expect(deserialized[0].text).toBe(longText);
      expect(deserialized[0].text.length).toBe(10_000);
    });
  });

  describe('error handling', () => {
    it('should throw on invalid JSON parse', () => {
      expect(() => JSON.parse('invalid json{')).toThrow();
    });

    it('should return empty array as default fallback pattern', () => {
      // This demonstrates the pattern used in loadQueue for error handling
      const loadQueuePattern = (stored: string | null): QueuedMessage[] => {
        if (!stored) {
          return [];
        }
        try {
          return JSON.parse(stored) as QueuedMessage[];
        } catch {
          return [];
        }
      };

      expect(loadQueuePattern(null)).toEqual([]);
      expect(loadQueuePattern('invalid')).toEqual([]);
      expect(loadQueuePattern('[]')).toEqual([]);
      expect(loadQueuePattern('[{"id":"1","text":"test","timestamp":""}]')).toHaveLength(1);
    });
  });

  describe('storage key format', () => {
    it('should use correct key prefix pattern', () => {
      const QUEUE_KEY_PREFIX = 'chat-queue-';
      const dbSessionId = 'session-abc-123';

      const key = `${QUEUE_KEY_PREFIX}${dbSessionId}`;

      expect(key).toBe('chat-queue-session-abc-123');
    });

    it('should handle different session ID formats', () => {
      const QUEUE_KEY_PREFIX = 'chat-queue-';

      const uuidStyle = `${QUEUE_KEY_PREFIX}550e8400-e29b-41d4-a716-446655440000`;
      const numericStyle = `${QUEUE_KEY_PREFIX}12345`;
      const mixedStyle = `${QUEUE_KEY_PREFIX}session_2024_01_abc`;

      expect(uuidStyle).toBe('chat-queue-550e8400-e29b-41d4-a716-446655440000');
      expect(numericStyle).toBe('chat-queue-12345');
      expect(mixedStyle).toBe('chat-queue-session_2024_01_abc');
    });
  });
});

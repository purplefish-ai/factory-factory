/**
 * Tests for conversation analyzer utilities
 */

import { describe, expect, it } from 'vitest';
import type { HistoryMessage } from '@/backend/domains/session/claude';
import { countUserMessages, extractKeyTopics } from './conversation-analyzer';

describe('conversation-analyzer', () => {
  describe('countUserMessages', () => {
    it('should count only user messages', () => {
      const history: HistoryMessage[] = [
        { type: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00Z' },
        { type: 'assistant', content: 'Hi', timestamp: '2024-01-01T00:00:01Z' },
        { type: 'user', content: 'How are you?', timestamp: '2024-01-01T00:00:02Z' },
        { type: 'tool_use', content: '{}', timestamp: '2024-01-01T00:00:03Z' },
      ];

      expect(countUserMessages(history)).toBe(2);
    });

    it('should return 0 for empty history', () => {
      expect(countUserMessages([])).toBe(0);
    });
  });

  describe('extractKeyTopics', () => {
    it('should extract key topics from user messages', () => {
      const history: HistoryMessage[] = [
        {
          type: 'user',
          content: 'I need to implement authentication using JWT tokens',
          timestamp: '2024-01-01T00:00:00Z',
        },
        {
          type: 'assistant',
          content: 'I can help you with that',
          timestamp: '2024-01-01T00:00:01Z',
        },
        {
          type: 'user',
          content: 'Also add OAuth support for Google login',
          timestamp: '2024-01-01T00:00:02Z',
        },
      ];

      const topics = extractKeyTopics(history);
      // Should detect 'auth' from authentication pattern
      expect(topics).toContain('auth');
      // Should include frequently used technical terms
      expect(topics.toLowerCase()).toMatch(/authentication|implement|oauth/i);
    });

    it('should filter out common stop words', () => {
      const history: HistoryMessage[] = [
        {
          type: 'user',
          content: 'The quick brown fox jumps over the lazy dog',
          timestamp: '2024-01-01T00:00:00Z',
        },
      ];

      const topics = extractKeyTopics(history);
      expect(topics).not.toContain('the');
      expect(topics).not.toContain('over');
    });

    it('should identify technical patterns', () => {
      const history: HistoryMessage[] = [
        {
          type: 'user',
          content: 'Fix the bug in the React component',
          timestamp: '2024-01-01T00:00:00Z',
        },
        {
          type: 'user',
          content: 'The API endpoint needs better error handling',
          timestamp: '2024-01-01T00:00:01Z',
        },
      ];

      const topics = extractKeyTopics(history);
      expect(topics.toLowerCase()).toMatch(/react|api|bug|fix/i);
    });

    it('should return empty string for empty history', () => {
      expect(extractKeyTopics([])).toBe('');
    });

    it('should return empty string when no user messages', () => {
      const history: HistoryMessage[] = [
        { type: 'assistant', content: 'Hello', timestamp: '2024-01-01T00:00:00Z' },
        { type: 'tool_use', content: '{}', timestamp: '2024-01-01T00:00:01Z' },
      ];

      expect(extractKeyTopics(history)).toBe('');
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSessionId } from './claude-code.client.js';

describe('claude-code.client', () => {
  describe('generateSessionId', () => {
    beforeEach(() => {
      // Mock Date.now to return a consistent timestamp
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-25T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should generate session ID in correct format for worker', () => {
      const sessionId = generateSessionId('worker', 'abc12345-6789-0123-4567-890abcdef012');
      expect(sessionId).toBe('worker-abc12345-1706184000');
    });

    it('should generate session ID in correct format for supervisor', () => {
      const sessionId = generateSessionId('supervisor', 'def67890-1234-5678-9012-345678901234');
      expect(sessionId).toBe('supervisor-def67890-1706184000');
    });

    it('should generate session ID in correct format for orchestrator', () => {
      const sessionId = generateSessionId('orchestrator', 'ghi12345-abcd-efgh-ijkl-mnopqrstuvwx');
      expect(sessionId).toBe('orchestrator-ghi12345-1706184000');
    });

    it('should handle short agent IDs gracefully', () => {
      const sessionId = generateSessionId('worker', 'short');
      expect(sessionId).toBe('worker-short-1706184000');
    });

    it('should handle exactly 8 character agent IDs', () => {
      const sessionId = generateSessionId('worker', 'exactly8');
      expect(sessionId).toBe('worker-exactly8-1706184000');
    });

    it('should truncate long agent IDs to 8 characters', () => {
      const sessionId = generateSessionId('worker', 'verylongagentid12345');
      expect(sessionId).toBe('worker-verylong-1706184000');
    });

    it('should include unix timestamp in seconds', () => {
      const sessionId = generateSessionId('worker', 'testid12');
      // 2024-01-25T12:00:00Z = 1706184000 seconds since epoch
      expect(sessionId).toMatch(/worker-testid12-\d+/);
      expect(sessionId.split('-')[2]).toBe('1706184000');
    });
  });
});

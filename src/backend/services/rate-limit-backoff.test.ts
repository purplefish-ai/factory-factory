import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isRateLimitMessage, RateLimitBackoff } from './rate-limit-backoff';

const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('isRateLimitMessage', () => {
  it('detects HTTP 429 message', () => {
    expect(isRateLimitMessage('http 429 too many requests')).toBe(true);
  });

  it('detects rate limit message', () => {
    expect(isRateLimitMessage('api rate limit exceeded')).toBe(true);
  });

  it('detects throttle message', () => {
    expect(isRateLimitMessage('request throttled by github')).toBe(true);
  });

  it('does not flag unrelated errors', () => {
    expect(isRateLimitMessage('network timeout')).toBe(false);
  });

  it('does not flag empty string', () => {
    expect(isRateLimitMessage('')).toBe(false);
  });
});

describe('RateLimitBackoff', () => {
  let backoff: RateLimitBackoff;

  beforeEach(() => {
    vi.clearAllMocks();
    backoff = new RateLimitBackoff();
  });

  describe('initial state', () => {
    it('starts with multiplier of 1', () => {
      expect(backoff.currentMultiplier).toBe(1);
    });

    it('computes delay equal to base interval initially', () => {
      expect(backoff.computeDelay(60_000)).toBe(60_000);
    });
  });

  describe('beginCycle', () => {
    it('resets the per-cycle flag', () => {
      backoff.beginCycle();
      // After beginCycle, a clean cycle reset should return false (multiplier is 1)
      const reset = backoff.resetIfCleanCycle(mockLogger as never, 'test');
      expect(reset).toBe(false);
    });
  });

  describe('handleError', () => {
    it('doubles multiplier on first rate limit error', () => {
      backoff.beginCycle();
      const isRateLimit = backoff.handleError(
        new Error('HTTP 429'),
        mockLogger as never,
        'test',
        { workspaceId: 'ws-1', prUrl: 'https://github.com/o/r/pull/1' },
        60_000
      );

      expect(isRateLimit).toBe(true);
      expect(backoff.currentMultiplier).toBe(2);
    });

    it('does not double multiplier twice in same cycle', () => {
      backoff.beginCycle();
      backoff.handleError(
        new Error('HTTP 429'),
        mockLogger as never,
        'test',
        { workspaceId: 'ws-1', prUrl: 'url1' },
        60_000
      );
      backoff.handleError(
        new Error('rate limit'),
        mockLogger as never,
        'test',
        { workspaceId: 'ws-2', prUrl: 'url2' },
        60_000
      );

      expect(backoff.currentMultiplier).toBe(2);
    });

    it('doubles again in a new cycle', () => {
      backoff.beginCycle();
      backoff.handleError(
        new Error('HTTP 429'),
        mockLogger as never,
        'test',
        { workspaceId: 'ws-1', prUrl: 'url1' },
        60_000
      );
      expect(backoff.currentMultiplier).toBe(2);

      backoff.beginCycle();
      backoff.handleError(
        new Error('HTTP 429'),
        mockLogger as never,
        'test',
        { workspaceId: 'ws-1', prUrl: 'url1' },
        60_000
      );
      expect(backoff.currentMultiplier).toBe(4);
    });

    it('caps at maxMultiplier (default 4)', () => {
      // Cycle 1: 1 -> 2
      backoff.beginCycle();
      backoff.handleError(
        new Error('HTTP 429'),
        mockLogger as never,
        'test',
        { workspaceId: 'ws-1', prUrl: 'url1' },
        60_000
      );

      // Cycle 2: 2 -> 4
      backoff.beginCycle();
      backoff.handleError(
        new Error('HTTP 429'),
        mockLogger as never,
        'test',
        { workspaceId: 'ws-1', prUrl: 'url1' },
        60_000
      );

      // Cycle 3: stays at 4
      backoff.beginCycle();
      backoff.handleError(
        new Error('HTTP 429'),
        mockLogger as never,
        'test',
        { workspaceId: 'ws-1', prUrl: 'url1' },
        60_000
      );

      expect(backoff.currentMultiplier).toBe(4);
    });

    it('respects custom maxMultiplier', () => {
      const smallBackoff = new RateLimitBackoff(2);
      smallBackoff.beginCycle();
      smallBackoff.handleError(
        new Error('HTTP 429'),
        mockLogger as never,
        'test',
        { workspaceId: 'ws-1', prUrl: 'url1' },
        60_000
      );
      expect(smallBackoff.currentMultiplier).toBe(2);

      smallBackoff.beginCycle();
      smallBackoff.handleError(
        new Error('HTTP 429'),
        mockLogger as never,
        'test',
        { workspaceId: 'ws-1', prUrl: 'url1' },
        60_000
      );
      // Should stay at 2
      expect(smallBackoff.currentMultiplier).toBe(2);
    });

    it('returns false and logs error for non-rate-limit errors', () => {
      backoff.beginCycle();
      const isRateLimit = backoff.handleError(
        new Error('network timeout'),
        mockLogger as never,
        'test',
        { workspaceId: 'ws-1', prUrl: 'url1' },
        60_000
      );

      expect(isRateLimit).toBe(false);
      expect(backoff.currentMultiplier).toBe(1);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('handles non-Error objects', () => {
      backoff.beginCycle();
      const isRateLimit = backoff.handleError(
        'string error',
        mockLogger as never,
        'test',
        { workspaceId: 'ws-1', prUrl: 'url1' },
        60_000
      );

      expect(isRateLimit).toBe(false);
    });

    it('handles non-Error objects that contain rate limit text', () => {
      backoff.beginCycle();
      const isRateLimit = backoff.handleError(
        'HTTP 429 rate limit',
        mockLogger as never,
        'test',
        { workspaceId: 'ws-1', prUrl: 'url1' },
        60_000
      );

      expect(isRateLimit).toBe(true);
      expect(backoff.currentMultiplier).toBe(2);
    });
  });

  describe('resetIfCleanCycle', () => {
    it('resets multiplier after a clean cycle', () => {
      // Build up multiplier
      backoff.beginCycle();
      backoff.handleError(
        new Error('HTTP 429'),
        mockLogger as never,
        'test',
        { workspaceId: 'ws-1', prUrl: 'url1' },
        60_000
      );
      expect(backoff.currentMultiplier).toBe(2);

      // New clean cycle
      backoff.beginCycle();
      const wasReset = backoff.resetIfCleanCycle(mockLogger as never, 'test');

      expect(wasReset).toBe(true);
      expect(backoff.currentMultiplier).toBe(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'test check succeeded, resetting backoff',
        expect.objectContaining({ previousMultiplier: 2 })
      );
    });

    it('returns false when multiplier is already 1', () => {
      backoff.beginCycle();
      const wasReset = backoff.resetIfCleanCycle(mockLogger as never, 'test');

      expect(wasReset).toBe(false);
      expect(backoff.currentMultiplier).toBe(1);
    });

    it('does not reset if rate limit was hit this cycle', () => {
      backoff.beginCycle();
      backoff.handleError(
        new Error('HTTP 429'),
        mockLogger as never,
        'test',
        { workspaceId: 'ws-1', prUrl: 'url1' },
        60_000
      );

      const wasReset = backoff.resetIfCleanCycle(mockLogger as never, 'test');

      expect(wasReset).toBe(false);
      expect(backoff.currentMultiplier).toBe(2);
    });
  });

  describe('computeDelay', () => {
    it('returns base interval times multiplier', () => {
      backoff.beginCycle();
      backoff.handleError(
        new Error('HTTP 429'),
        mockLogger as never,
        'test',
        { workspaceId: 'ws-1', prUrl: 'url1' },
        60_000
      );

      expect(backoff.computeDelay(60_000)).toBe(120_000);
    });
  });
});

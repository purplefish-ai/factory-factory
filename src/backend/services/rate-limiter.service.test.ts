import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rateLimiter } from './rate-limiter.service';

type RateLimiterInternals = {
  requestTimestamps: number[];
  requestQueue: unknown[];
  isShuttingDown: boolean;
  isProcessingQueue: boolean;
  cleanupInterval: NodeJS.Timeout | null;
  queueProcessingTimeout: NodeJS.Timeout | null;
  queueProcessingResolve: (() => void) | null;
  queueProcessingPromise: Promise<void> | null;
  pendingTimeouts: Map<string, NodeJS.Timeout>;
};

function getInternals(): RateLimiterInternals {
  return rateLimiter as unknown as RateLimiterInternals;
}

describe('rateLimiter', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    await rateLimiter.stop();

    const internals = getInternals();
    internals.requestTimestamps = [];
    internals.requestQueue = [];
    internals.isShuttingDown = false;
    internals.isProcessingQueue = false;
    internals.cleanupInterval = null;
    internals.queueProcessingTimeout = null;
    internals.queueProcessingResolve = null;
    internals.queueProcessingPromise = null;
    internals.pendingTimeouts = new Map();

    rateLimiter.resetUsageStats();
    rateLimiter.updateConfig({
      claudeRequestsPerMinute: 1,
      claudeRequestsPerHour: 2,
      maxQueueSize: 2,
      queueTimeoutMs: 120_000,
    });
  });

  afterEach(async () => {
    await rateLimiter.stop();
    vi.useRealTimers();
  });

  it('acquires slots immediately when not rate-limited', async () => {
    await expect(rateLimiter.acquireSlot('agent-1', 'task-1')).resolves.toBeUndefined();

    const stats = rateLimiter.getApiUsageStats();
    expect(stats).toMatchObject({
      totalRequests: 1,
      requestsLastMinute: 1,
      requestsLastHour: 1,
      queueDepth: 0,
      isRateLimited: true,
    });

    expect(Object.fromEntries(rateLimiter.getUsageByAgent())).toEqual({ 'agent-1': 1 });
    expect(Object.fromEntries(rateLimiter.getUsageByTopLevelTask())).toEqual({ 'task-1': 1 });
  });

  it('queues requests while rate-limited and drains when window expires', async () => {
    await rateLimiter.acquireSlot('agent-1', null);

    let resolved = false;
    const queued = rateLimiter.acquireSlot('agent-2', null).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(rateLimiter.getApiUsageStats().queueDepth).toBe(1);
    expect(resolved).toBe(false);

    getInternals().requestTimestamps = [];
    vi.advanceTimersByTime(1000);
    await queued;

    expect(resolved).toBe(true);
    expect(rateLimiter.getApiUsageStats().totalRequests).toBe(2);
  });

  it('keeps queue processing active when a resolved queued request immediately re-queues', async () => {
    await rateLimiter.acquireSlot('agent-1', null);

    let thirdAcquire: Promise<void> | null = null;
    const secondAcquire = rateLimiter.acquireSlot('agent-2', null).then(() => {
      thirdAcquire = rateLimiter.acquireSlot('agent-3', null);
      void thirdAcquire.catch(() => undefined);
    });

    await Promise.resolve();
    expect(rateLimiter.getApiUsageStats().queueDepth).toBe(1);

    getInternals().requestTimestamps = [];
    vi.advanceTimersByTime(1000);
    await secondAcquire;
    await Promise.resolve();

    expect(rateLimiter.getApiUsageStats().queueDepth).toBe(1);
    expect(getInternals().isProcessingQueue).toBe(true);
    expect(getInternals().queueProcessingPromise).not.toBeNull();

    if (!thirdAcquire) {
      throw new Error('Expected third acquire request to be queued');
    }

    getInternals().requestTimestamps = [];
    vi.advanceTimersByTime(1000);
    await expect(thirdAcquire).resolves.toBeUndefined();
    expect(rateLimiter.getApiUsageStats().queueDepth).toBe(0);
  });

  it('rejects when queue is full', async () => {
    rateLimiter.updateConfig({
      claudeRequestsPerMinute: 0,
      claudeRequestsPerHour: 0,
      maxQueueSize: 0,
    });

    await expect(rateLimiter.acquireSlot('agent-3', null)).rejects.toThrow(
      'Rate limit queue is full'
    );
  });

  it('times out queued requests and clears usage statistics', async () => {
    rateLimiter.updateConfig({ queueTimeoutMs: 100 });
    await rateLimiter.acquireSlot('agent-1', null);

    const queued = rateLimiter.acquireSlot('agent-2', null);
    const timeoutAssertion = expect(queued).rejects.toThrow('Rate limit queue timeout');
    await vi.advanceTimersByTimeAsync(101);

    await timeoutAssertion;

    rateLimiter.resetUsageStats();
    expect(rateLimiter.getApiUsageStats().totalRequests).toBe(0);
    expect(rateLimiter.getUsageByAgent().size).toBe(0);
    expect(rateLimiter.getUsageByTopLevelTask().size).toBe(0);
  });

  it('rejects queued requests during shutdown and supports start lifecycle', async () => {
    rateLimiter.start();
    rateLimiter.start();

    await rateLimiter.acquireSlot('agent-1', null);
    const queued = rateLimiter.acquireSlot('agent-2', null);

    await rateLimiter.stop();
    await expect(queued).rejects.toThrow('Rate limiter shutting down');

    rateLimiter.updateConfig({ claudeRequestsPerMinute: 10 });
    expect(rateLimiter.getConfig().claudeRequestsPerMinute).toBe(10);
  });
});

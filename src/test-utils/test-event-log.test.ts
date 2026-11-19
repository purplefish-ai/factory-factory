import { describe, expect, it, vi } from 'vitest';
import { createTestEventLog } from './test-event-log';

describe('test event signals', () => {
  it('observes events recorded before a waiter is registered', async () => {
    const log = createTestEventLog<string>();
    log.record('first');
    await log.waitForCount(1);
    expect(log.events).toEqual(['first']);
  });

  it('wakes concurrent waiters at their requested counts', async () => {
    const log = createTestEventLog<string>();
    const second = vi.fn();
    const one = log.waitForCount(1);
    const two = log.waitForCount(2).then(second);
    log.record('first');
    await one;
    expect(second).not.toHaveBeenCalled();
    log.record('second');
    await two;
    expect(second).toHaveBeenCalledOnce();
    expect(log.events).toEqual(['first', 'second']);
  });
});

import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { attachCloseWatcherWithRetry } from './retry-logic';

describe('attachCloseWatcherWithRetry', () => {
  it.each([
    { connectionRejects: false, cleanupRejects: false },
    { connectionRejects: true, cleanupRejects: false },
    { connectionRejects: false, cleanupRejects: true },
    { connectionRejects: true, cleanupRejects: true },
  ])('runs async cleanup once after connection closure: %j', async (scenario) => {
    let cleanups = 0;
    attachCloseWatcherWithRetry({
      getClosed: () =>
        scenario.connectionRejects
          ? Promise.reject(new Error('connection closed'))
          : Promise.resolve(),
      onClose: async () => {
        await Promise.resolve();
        cleanups += 1;
        if (scenario.cleanupRejects) {
          throw new Error('cleanup failed');
        }
      },
      onAttachRetryLimitReached: () => {
        throw new Error('Unexpected retry exhaustion');
      },
    });

    await delay(0);

    expect(cleanups).toBe(1);
  });
});

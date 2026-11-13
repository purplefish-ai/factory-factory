import { describe, expect, it } from 'vitest';
import { HELPER_LIFETIME_MS, spawnSleeper } from './test-support';

describe('test helper processes', () => {
  it('exit on their own, so an interrupted run cannot leave one behind', async () => {
    expect(HELPER_LIFETIME_MS).toBeLessThanOrEqual(120_000);
    const sleeper = spawnSleeper({ lifetimeMs: 300 });
    try {
      const code = await new Promise((resolve) => sleeper.once('exit', resolve));
      expect(code).toBe(0);
    } finally {
      sleeper.kill('SIGKILL');
    }
  }, 30_000);
});

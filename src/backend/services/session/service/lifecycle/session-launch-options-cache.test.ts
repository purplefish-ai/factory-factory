import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import type { SessionLaunchOptions } from '@/shared/session-launch';
import { SessionLaunchOptionsService } from './session-launch-options.service';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }));
vi.mock('@/backend/services/logger.service', () => ({ createLogger: () => logs }));

const input = { provider: 'CLAUDE' as const, model: 'opus' };
const value: SessionLaunchOptions = {
  provider: 'CLAUDE',
  model: 'opus',
  reasoning: { options: [{ value: 'high', label: 'High' }], defaultValue: 'high' },
  planMode: { supported: true, selected: false },
};
function fixture() {
  const fetchOptions = vi.fn(async () => ({
    result: Promise.resolve(structuredClone(value)),
    drained: Promise.resolve(),
  }));
  const service = new SessionLaunchOptionsService({
    fetchOptions,
    getSettings: async () => ({}),
  });
  return { service, fetchOptions };
}

describe('launch discovery cache refresh', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reuses successful options beyond the old 30-second expiry', async () => {
    const f = fixture();
    await f.service.getOptions(input);
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(await f.service.getOptions(input)).toEqual(value);
    expect(f.fetchOptions).toHaveBeenCalledTimes(1);
  });

  it('returns stale clones immediately and coalesces background refreshes', async () => {
    const f = fixture();
    await f.service.getOptions(input);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const refresh = createDeferred<SessionLaunchOptions>();
    f.fetchOptions.mockResolvedValueOnce({
      result: refresh.promise,
      drained: refresh.promise.then(() => undefined),
    });
    const first = await f.service.getOptions(input);
    first.reasoning.options.length = 0;
    expect(await f.service.getOptions(input)).toEqual(value);
    expect(f.fetchOptions).toHaveBeenCalledTimes(2);
    refresh.resolve({ ...value, planMode: { supported: false, selected: false } });
    await vi.advanceTimersByTimeAsync(0);
    expect((await f.service.getOptions(input)).planMode.supported).toBe(false);
    expect(f.fetchOptions).toHaveBeenCalledTimes(2);
  });

  it('keeps the last success on refresh failure and backs off before retrying', async () => {
    const f = fixture();
    await f.service.getOptions(input);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    f.fetchOptions.mockRejectedValueOnce(new Error('provider diagnostic containing a secret'));
    expect(await f.service.getOptions(input)).toEqual(value);
    await vi.advanceTimersByTimeAsync(0);
    expect(await f.service.getOptions(input)).toEqual(value);
    expect(f.fetchOptions).toHaveBeenCalledTimes(2);
    expect(logs.warn).toHaveBeenCalledWith('Launch options background refresh failed', input);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await f.service.getOptions(input)).toEqual(value);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetchOptions).toHaveBeenCalledTimes(3);
  });

  it('requires a fresh success after the maximum age even when refresh failed', async () => {
    const f = fixture();
    await f.service.getOptions(input);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    f.fetchOptions.mockRejectedValueOnce(new Error('refresh failed'));
    await f.service.getOptions(input);
    await vi.advanceTimersByTimeAsync(25 * 60_000);
    f.fetchOptions.mockRejectedValueOnce(new Error('fresh discovery failed'));
    await expect(f.service.getOptions(input)).rejects.toThrow('fresh discovery failed');
  });

  it.each([false, true])(
    'restores an evicted fallback only within its maximum age (expired=%s)',
    async (expired) => {
      const f = fixture();
      await f.service.getOptions(input);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const refresh = createDeferred<SessionLaunchOptions>();
      f.fetchOptions.mockResolvedValueOnce({
        result: refresh.promise,
        drained: refresh.promise.then(
          () => undefined,
          () => undefined
        ),
      });
      await f.service.getOptions(input);
      // The 33rd cached key evicts this key while its refresh is still pending.
      for (let i = 0; i < 32; i++) {
        await f.service.getOptions({ ...input, model: `other-${i}` });
      }
      if (expired) {
        await vi.advanceTimersByTimeAsync(25 * 60_000);
      }
      refresh.reject(new Error('refresh failed after eviction'));
      await vi.advanceTimersByTimeAsync(0);
      f.fetchOptions.mockRejectedValueOnce(new Error('new discovery failed'));
      if (expired) {
        await expect(f.service.getOptions(input)).rejects.toThrow('new discovery failed');
      } else {
        expect(await f.service.getOptions(input)).toEqual(value);
        expect(f.fetchOptions).toHaveBeenCalledTimes(34);
        // Restoring a fallback must still respect the 32-entry cache bound.
        await expect(f.service.getOptions({ ...input, model: 'other-0' })).rejects.toThrow(
          'new discovery failed'
        );
      }
    }
  );

  it('serves stale options while a successful probe still owns its process slot', async () => {
    const f = fixture();
    const drained = createDeferred<void>();
    f.fetchOptions.mockResolvedValueOnce({
      result: Promise.resolve(value),
      drained: drained.promise,
    });
    await f.service.getOptions(input);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await f.service.getOptions(input)).toEqual(value);
    expect(f.fetchOptions).toHaveBeenCalledTimes(1);
    drained.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(await f.service.getOptions(input)).toEqual(value);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetchOptions).toHaveBeenCalledTimes(2);
  });

  it('serves stale options when other discoveries fill every process slot', async () => {
    const f = fixture();
    await f.service.getOptions(input);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const discovery = createDeferred<SessionLaunchOptions>();
    f.fetchOptions.mockImplementation(async () => ({
      result: discovery.promise,
      drained: discovery.promise.then(() => undefined),
    }));
    const running = Array.from({ length: 8 }, (_, i) =>
      f.service.getOptions({ ...input, model: `other-${i}` })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(await f.service.getOptions(input)).toEqual(value);
    expect(f.fetchOptions).toHaveBeenCalledTimes(9);
    discovery.resolve(value);
    await Promise.all(running);
  });
});

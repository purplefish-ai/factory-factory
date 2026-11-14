import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { SessionLaunchOptionsService } from '@/backend/services/session/service/config/launch-options/session-launch-options.service';
import type { SessionLaunchOptions } from '@/shared/session-launch';

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
    await vi.advanceTimersByTimeAsync(29_999);
    expect(await f.service.getOptions(input)).toEqual(value);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetchOptions).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await f.service.getOptions(input)).toEqual(value);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetchOptions).toHaveBeenCalledTimes(3);
  });

  it('keeps old successful options through refresh failures without a hard expiry', async () => {
    const f = fixture();
    await f.service.getOptions(input);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    f.fetchOptions.mockRejectedValueOnce(new Error('refresh failed'));
    expect(await f.service.getOptions(input)).toEqual(value);
    await vi.advanceTimersByTimeAsync(0);
    expect(await f.service.getOptions(input)).toEqual(value);
    expect(f.fetchOptions).toHaveBeenCalledTimes(2);
  });

  it('does not resolve the account again when serving a cached preview', async () => {
    const resolveAccountId = vi.fn().mockResolvedValue('saved-account');
    const fetchOptions = vi.fn(async () => ({
      result: Promise.resolve({ ...value, provider: 'CODEX' as const }),
      drained: Promise.resolve(),
    }));
    const service = new SessionLaunchOptionsService({
      fetchOptions,
      resolveAccountId,
      getSettings: async () => ({}),
    });
    const request = { provider: 'CODEX' as const, model: 'model' };
    await service.getOptions(request);
    resolveAccountId.mockRejectedValue(new Error('slow/offline account probe'));
    expect((await service.getOptions(request)).provider).toBe('CODEX');
    expect(resolveAccountId).toHaveBeenCalledTimes(1);
  });

  it('restores options before serving reads and refreshes them without waiting', async () => {
    const load = vi.fn(async () => [{ input, value, capturedAt: Date.now() }]);
    const refresh = createDeferred<SessionLaunchOptions>();
    const save = vi.fn(async () => undefined);
    const fetchOptions = vi.fn(async () => ({
      result: refresh.promise,
      drained: refresh.promise.then(() => undefined),
    }));
    const service = new SessionLaunchOptionsService({
      fetchOptions,
      getSettings: async () => ({}),
      store: { load, save },
    });
    expect(await service.getOptions(input)).toEqual(value);
    expect(load).toHaveBeenCalledOnce();
    expect(fetchOptions).toHaveBeenCalledOnce();
    refresh.resolve({ ...value, planMode: { supported: false, selected: false } });
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledWith([
      expect.objectContaining({
        input,
        value: expect.objectContaining({ planMode: { supported: false, selected: false } }),
      }),
    ]);
  });

  it('keeps serving options and stops cleanly when saving the snapshot fails', async () => {
    const save = vi.fn(() => Promise.reject(new Error('disk full')));
    const fetchOptions = vi.fn(async () => ({
      result: Promise.resolve(structuredClone(value)),
      drained: Promise.resolve(),
    }));
    const service = new SessionLaunchOptionsService({
      fetchOptions,
      getSettings: async () => ({}),
      store: { load: async () => [], save },
    });
    expect(await service.getOptions(input)).toEqual(value);
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledOnce();
    expect(logs.warn).toHaveBeenCalledWith('Launch options cache save failed');
    expect(await service.getOptions(input)).toEqual(value);
    expect(fetchOptions).toHaveBeenCalledOnce();
    await expect(service.stop()).resolves.toBeUndefined();
  });

  it('warms saved default models while isolating a failed provider', async () => {
    const fetchOptions = vi.fn(({ provider, model }) => {
      if (provider === 'CODEX') {
        return Promise.reject(new Error('not signed in'));
      }
      return Promise.resolve({
        result: Promise.resolve({ ...value, model }),
        drained: Promise.resolve(),
      });
    });
    const service = new SessionLaunchOptionsService({
      fetchOptions,
      getSettings: async () => ({ defaultClaudeModel: 'sonnet', defaultCodexModel: 'codex' }),
    });
    await service.warm();
    expect(fetchOptions).toHaveBeenCalledWith(
      { provider: 'CLAUDE', model: 'sonnet' },
      expect.any(AbortSignal),
      expect.any(Function)
    );
    expect(fetchOptions).toHaveBeenCalledWith(
      { provider: 'CODEX', model: 'codex' },
      expect.any(AbortSignal),
      expect.any(Function)
    );
    expect((await service.getOptions({ provider: 'CLAUDE' })).model).toBe('sonnet');
    expect(fetchOptions).toHaveBeenCalledTimes(2);
  });

  it('fences warmup stopped during disk restoration', async () => {
    const restored = createDeferred<[]>();
    const fetchOptions = vi.fn();
    const getSettings = vi.fn(async () => ({}));
    const service = new SessionLaunchOptionsService({
      fetchOptions,
      getSettings,
      store: { load: () => restored.promise, save: async () => undefined },
    });
    const warming = service.warm();
    await vi.advanceTimersByTimeAsync(0);
    await service.stop();
    restored.resolve([]);
    await warming;
    expect(fetchOptions).not.toHaveBeenCalled();
    expect(getSettings).not.toHaveBeenCalled();
    await expect(service.getOptions(input)).rejects.toThrow('stopped');
  });

  it('aborts native discovery and waits for its physical drain on stop', async () => {
    const result = createDeferred<SessionLaunchOptions>();
    const drained = createDeferred<void>();
    let signal: AbortSignal | undefined;
    const fetchOptions = vi.fn((_input, receivedSignal) => {
      signal = receivedSignal;
      receivedSignal.addEventListener('abort', () => result.reject(new Error('cancelled')), {
        once: true,
      });
      return Promise.resolve({ result: result.promise, drained: drained.promise });
    });
    const service = new SessionLaunchOptionsService({
      fetchOptions,
      getSettings: async () => ({}),
    });
    const reading = service.getOptions(input).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(true);
    expect(stopped).toBe(false);
    expect(await reading).toBeInstanceOf(Error);
    drained.resolve();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('stops waiting for an undrained child after seven seconds', async () => {
    const fetchOptions = vi.fn(async () => ({
      result: Promise.resolve(structuredClone(value)),
      drained: new Promise<void>(() => undefined),
    }));
    const service = new SessionLaunchOptionsService({
      fetchOptions,
      getSettings: async () => ({}),
    });
    await service.getOptions(input);
    let outcome: unknown;
    const stopping = service.stop().then(
      () => {
        outcome = 'drained';
      },
      (error: unknown) => {
        outcome = error;
      }
    );
    await vi.advanceTimersByTimeAsync(6999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toMatchObject({ message: expect.stringContaining('timed out') });
    await stopping;
  });

  it('restores an evicted last success after refresh failure within the cache bound', async () => {
    const f = fixture();
    await f.service.getOptions(input);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    const refresh = createDeferred<SessionLaunchOptions>();
    f.fetchOptions.mockResolvedValueOnce({
      result: refresh.promise,
      drained: refresh.promise.then(
        () => undefined,
        () => undefined
      ),
    });
    await f.service.getOptions(input);
    for (let i = 0; i < 128; i++) {
      await f.service.getOptions({ ...input, model: `other-${i}` });
    }
    refresh.reject(new Error('refresh failed after eviction'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await f.service.getOptions(input)).toEqual(value);
    f.fetchOptions.mockRejectedValueOnce(new Error('evicted entry needs discovery'));
    await expect(f.service.getOptions({ ...input, model: 'other-0' })).rejects.toThrow(
      'evicted entry needs discovery'
    );
  });

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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { deferred } from '@/test-utils/deferred';
import { ModelCatalogCache } from './model-catalog-cache';

const logs = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/backend/services/logger.service', () => ({ createLogger: () => logs }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('catalog background refresh lifetime', () => {
  it('fences queued discovery when shutdown starts', async () => {
    const fetchModels = vi.fn(async () => ['model']);
    const cache = new ModelCatalogCache({ fetchModels });
    const reading = cache.getModels();
    const stopped = cache.stop();
    await expect(reading).rejects.toThrow('stopped');
    await stopped;
    expect(fetchModels).not.toHaveBeenCalled();
    await expect(cache.getModels()).rejects.toThrow('stopped');
  });

  it('aborts a background refresh and waits for its provider cleanup', async () => {
    vi.useFakeTimers();
    const cleanup = deferred<void>();
    let activeSignal: AbortSignal | undefined;
    const fetchModels = vi
      .fn<(signal?: AbortSignal) => Promise<string[]>>()
      .mockResolvedValueOnce(['model'])
      .mockImplementationOnce((signal) => {
        activeSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              void cleanup.promise.then(() => reject(signal.reason));
            },
            { once: true }
          );
        });
      });
    const cache = new ModelCatalogCache({ fetchModels });
    await cache.getModels();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await cache.getModels()).toEqual(['model']);
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = cache.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(activeSignal?.aborted).toBe(true);
    expect(stopped).toBe(false);
    cleanup.resolve();
    await stopping;
    expect(stopped).toBe(true);
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('returns a bounded failure but retains admission and shutdown drain for open pipes', async () => {
    const pipes = deferred<void>();
    const fetchModels = vi.fn((_signal, retainLifetime) => {
      retainLifetime(pipes.promise);
      return Promise.reject(new Error('catalog timed out'));
    });
    const cache = new ModelCatalogCache({ fetchModels });
    await expect(cache.getModels()).rejects.toThrow('catalog timed out');
    await expect(cache.getModels()).rejects.toThrow('busy');
    expect(fetchModels).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = cache.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    pipes.resolve();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('logs one sanitized warning per failed refresh, while retaining the last success', async () => {
    vi.useFakeTimers();
    const failed = createDeferred<string[]>();
    const fetchModels = vi.fn().mockResolvedValueOnce(['model']).mockReturnValue(failed.promise);
    const cache = new ModelCatalogCache<string[]>({ fetchModels });
    await cache.getModels();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await Promise.all([cache.getModels(), cache.getModels()]);
    failed.reject(new Error('diagnostic containing credentials'));
    await vi.advanceTimersByTimeAsync(0);
    expect(logs.warn).toHaveBeenCalledExactlyOnceWith('Model catalog background refresh failed');
    expect(await cache.getModels()).toEqual(['model']);
    expect(fetchModels).toHaveBeenCalledTimes(2);
  });
});

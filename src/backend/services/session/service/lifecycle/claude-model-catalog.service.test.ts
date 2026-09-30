import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeModelCatalogService } from './claude-model-catalog.service';
import { createDeferred } from './session-lifecycle.test-helpers';

function catalog() {
  return [{ id: 'claude-test', displayName: 'Claude Test', description: 'Test model' }];
}

describe('ClaudeModelCatalogService', () => {
  afterEach(() => vi.useRealTimers());

  it('shares discovery across concurrent consumers', async () => {
    const pending = createDeferred<ReturnType<typeof catalog>>();
    const fetchModels = vi.fn(() => pending.promise);
    const service = new ClaudeModelCatalogService({ fetchModels });

    const first = service.getModels();
    const second = service.getModels();
    pending.resolve(catalog());

    await expect(first).resolves.toEqual(catalog());
    await expect(second).resolves.toEqual(catalog());
    expect(fetchModels).toHaveBeenCalledOnce();
  });

  it('keeps successful discovery for 30 seconds from completion', async () => {
    vi.useFakeTimers();
    const pending = createDeferred<ReturnType<typeof catalog>>();
    const fetchModels = vi.fn(() => pending.promise);
    const service = new ClaudeModelCatalogService({ fetchModels });
    const first = service.getModels();
    await vi.advanceTimersByTimeAsync(5000);
    pending.resolve(catalog());
    await first;

    await vi.advanceTimersByTimeAsync(29_999);
    await expect(service.getModels()).resolves.toEqual(catalog());
    expect(fetchModels).toHaveBeenCalledOnce();
    fetchModels.mockResolvedValue([{ ...catalog()[0]!, id: 'new-model' }]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(service.getModels()).resolves.toMatchObject([{ id: 'new-model' }]);
    expect(fetchModels).toHaveBeenCalledTimes(2);
  });

  it('shares discovery failures and retries on the next request', async () => {
    const pending = createDeferred<ReturnType<typeof catalog>>();
    const fetchModels = vi.fn(() => pending.promise);
    const service = new ClaudeModelCatalogService({ fetchModels });
    const first = service.getModels();
    const second = service.getModels();
    const error = new Error('Claude ACP unavailable');
    const results = Promise.allSettled([first, second]);
    pending.reject(error);
    await expect(results).resolves.toEqual([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error },
    ]);
    expect(fetchModels).toHaveBeenCalledOnce();

    fetchModels.mockResolvedValue(catalog());
    await expect(service.getModels()).resolves.toEqual(catalog());
    expect(fetchModels).toHaveBeenCalledTimes(2);
  });
});
